use std::ffi::c_void;
use std::fs::File;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::Path;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Storage::FileSystem::{
    FileDispositionInfo, FileIdInfo, FileRenameInfoEx, GetFileInformationByHandleEx,
    GetVolumeInformationByHandleW, SetFileInformationByHandle, FILE_DEVICE_DISK, FILE_ID_INFO,
};

/// A volume-qualified, full FILE_ID_128 identity.  Do not truncate this to the
/// legacy 64-bit file-index fields: Windows is permitted to use all 128 bits.
pub(super) type FileIdentity = (u64, u128);

pub(super) fn file_identity(file: &File) -> Result<FileIdentity, ()> {
    let mut information = FILE_ID_INFO::default();
    if unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileIdInfo,
            &mut information as *mut _ as *mut c_void,
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
    } == 0
    {
        return Err(());
    }
    Ok((
        information.VolumeSerialNumber,
        u128::from_le_bytes(information.FileId.Identifier),
    ))
}

// NtCreateFile is the only generally available Win32 primitive which can both
// resolve a single child relative to an already-retained directory and return
// the resulting handle.  Using FILE_OPEN_IF makes creation/open one indivisible
// namespace operation: there is no mkdir/stat/open interval in which another
// object can be adopted.
#[repr(C)]
struct UnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *mut u16,
}
#[repr(C)]
struct ObjectAttributes {
    length: u32,
    root_directory: HANDLE,
    object_name: *mut UnicodeString,
    attributes: u32,
    security_descriptor: *mut c_void,
    security_quality_of_service: *mut c_void,
}
#[repr(C)]
struct IoStatusBlock {
    status: isize,
    information: usize,
}

#[repr(C)]
struct FileFsDeviceInformation {
    device_type: u32,
    characteristics: u32,
}

#[link(name = "ntdll")]
extern "system" {
    fn NtCreateFile(
        file_handle: *mut HANDLE,
        desired_access: u32,
        object_attributes: *mut ObjectAttributes,
        io_status_block: *mut IoStatusBlock,
        allocation_size: *mut i64,
        file_attributes: u32,
        share_access: u32,
        create_disposition: u32,
        create_options: u32,
        ea_buffer: *mut c_void,
        ea_length: u32,
    ) -> i32;
    fn NtSetInformationFile(
        file_handle: HANDLE,
        io_status_block: *mut IoStatusBlock,
        file_information: *mut c_void,
        length: u32,
        file_information_class: i32,
    ) -> i32;
    fn NtQueryVolumeInformationFile(
        file_handle: HANDLE,
        io_status_block: *mut IoStatusBlock,
        fs_information: *mut c_void,
        length: u32,
        fs_information_class: i32,
    ) -> i32;
    fn NtQueryDirectoryFile(
        file_handle: HANDLE,
        event: HANDLE,
        apc_routine: *mut c_void,
        apc_context: *mut c_void,
        io_status_block: *mut IoStatusBlock,
        file_information: *mut c_void,
        length: u32,
        file_information_class: i32,
        return_single_entry: u8,
        file_name: *mut UnicodeString,
        restart_scan: u8,
    ) -> i32;
}

/// Enumerate names from the retained directory object itself.  No DOS/Win32
/// pathname is reconstructed, so replacement of any ancestor cannot redirect
/// the scan.
pub(super) fn list_relative_names(directory: &File) -> Result<Vec<String>, ()> {
    let mut output = Vec::new();
    let mut restart = 1u8;
    loop {
        let mut buffer = vec![0u8; 32 * 1024];
        let mut status = IoStatusBlock {
            status: 0,
            information: 0,
        };
        let result = unsafe {
            NtQueryDirectoryFile(
                directory.as_raw_handle(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut status,
                buffer.as_mut_ptr() as *mut c_void,
                buffer.len() as u32,
                12, // FileNamesInformation
                0,
                std::ptr::null_mut(),
                restart,
            )
        };
        restart = 0;
        if result as u32 == 0x8000_0006 {
            // STATUS_NO_MORE_FILES
            break;
        }
        if result < 0 || status.information > buffer.len() {
            return Err(());
        }
        let mut offset = 0usize;
        loop {
            if offset + 12 > status.information {
                return Err(());
            }
            let next =
                u32::from_ne_bytes(buffer[offset..offset + 4].try_into().map_err(|_| ())?) as usize;
            let name_bytes =
                u32::from_ne_bytes(buffer[offset + 8..offset + 12].try_into().map_err(|_| ())?)
                    as usize;
            if name_bytes % 2 != 0 || offset + 12 + name_bytes > status.information {
                return Err(());
            }
            let wide = buffer[offset + 12..offset + 12 + name_bytes]
                .chunks_exact(2)
                .map(|value| u16::from_le_bytes([value[0], value[1]]))
                .collect::<Vec<_>>();
            let name = String::from_utf16(&wide).map_err(|_| ())?;
            if name != "." && name != ".." {
                if output.len() >= 4096
                    || output.iter().map(String::len).sum::<usize>() + name.len() > 48 * 1024
                {
                    return Err(());
                }
                output.push(name);
            }
            if next == 0 {
                break;
            }
            if next < 12
                || offset
                    .checked_add(next)
                    .filter(|value| *value < status.information)
                    .is_none()
            {
                return Err(());
            }
            offset += next;
        }
    }
    Ok(output)
}

/// Prove the filesystem and device class on the retained volume handle. Path
/// queries such as GetDriveTypeW/GetVolumeInformationW are only an early
/// rejection filter: a drive mapping can change between those queries and the
/// authority-producing open.
pub(super) fn validate_local_ntfs(file: &File) -> Result<(), ()> {
    let mut filesystem = [0u16; 32];
    if unsafe {
        GetVolumeInformationByHandleW(
            file.as_raw_handle(),
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            filesystem.as_mut_ptr(),
            filesystem.len() as u32,
        )
    } == 0
    {
        return Err(());
    }
    let end = filesystem
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(filesystem.len());
    if filesystem[..end] != ['N' as u16, 'T' as u16, 'F' as u16, 'S' as u16] {
        return Err(());
    }
    let mut status = IoStatusBlock {
        status: 0,
        information: 0,
    };
    let mut device = FileFsDeviceInformation {
        device_type: 0,
        characteristics: 0,
    };
    // FileFsDeviceInformation is FS_INFORMATION_CLASS 4. Reject removable and
    // remote devices even if a path-level drive query previously said fixed.
    if unsafe {
        NtQueryVolumeInformationFile(
            file.as_raw_handle(),
            &mut status,
            &mut device as *mut _ as *mut c_void,
            std::mem::size_of::<FileFsDeviceInformation>() as u32,
            4,
        )
    } < 0
        || device.device_type != FILE_DEVICE_DISK
        || device.characteristics & (0x0000_0001 | 0x0000_0010) != 0
    {
        return Err(());
    }
    Ok(())
}

pub(super) fn open_relative_directory(
    parent: &File,
    component: &Path,
    create: bool,
) -> Result<(File, bool), ()> {
    open_relative_directory_with_disposition(
        parent,
        component,
        if create { 3 } else { 1 },
        true,
        false,
    )
}

pub(super) fn create_relative_directory(parent: &File, component: &Path) -> Result<File, ()> {
    let (file, created) =
        open_relative_directory_with_disposition(parent, component, 2, true, true)?;
    if !created {
        return Err(());
    }
    Ok(file)
}

pub(super) fn probe_relative_directory(parent: &File, component: &Path) -> Result<File, ()> {
    let (file, created) =
        open_relative_directory_with_disposition(parent, component, 1, false, false)?;
    if created {
        return Err(());
    }
    Ok(file)
}

pub(super) fn open_relative_directory_for_delete(
    parent: &File,
    component: &Path,
) -> Result<File, ()> {
    let (file, created) =
        open_relative_directory_with_disposition(parent, component, 1, true, true)?;
    if created {
        return Err(());
    }
    Ok(file)
}

pub(super) fn create_relative_file(parent: &File, component: &Path) -> Result<File, ()> {
    open_relative_file_with_disposition(parent, component, 2, true)?.ok_or(())
}

pub(super) fn open_relative_file(parent: &File, component: &Path) -> Result<File, ()> {
    open_relative_file_with_disposition(parent, component, 1, true)?.ok_or(())
}

pub(super) fn open_relative_file_optional(
    parent: &File,
    component: &Path,
) -> Result<Option<File>, ()> {
    open_relative_file_with_disposition(parent, component, 1, true)
}

pub(super) fn probe_relative_file(parent: &File, component: &Path) -> Result<File, ()> {
    open_relative_file_with_disposition(parent, component, 1, false)?.ok_or(())
}

pub(super) fn probe_relative_file_optional(
    parent: &File,
    component: &Path,
) -> Result<Option<File>, ()> {
    open_relative_file_with_disposition(parent, component, 1, false)
}

fn open_relative_file_with_disposition(
    parent: &File,
    component: &Path,
    disposition: u32,
    authority: bool,
) -> Result<Option<File>, ()> {
    let mut name = component.as_os_str().encode_wide().collect::<Vec<_>>();
    if name.is_empty()
        || name.iter().any(|value| *value == 0)
        || name.len() > (u16::MAX as usize / 2)
    {
        return Err(());
    }
    let mut unicode = UnicodeString {
        length: (name.len() * 2) as u16,
        maximum_length: (name.len() * 2) as u16,
        buffer: name.as_mut_ptr(),
    };
    let mut attributes = ObjectAttributes {
        length: std::mem::size_of::<ObjectAttributes>() as u32,
        root_directory: parent.as_raw_handle(),
        object_name: &mut unicode,
        attributes: 0x40,
        security_descriptor: std::ptr::null_mut(),
        security_quality_of_service: std::ptr::null_mut(),
    };
    let mut status = IoStatusBlock {
        status: 0,
        information: 0,
    };
    let mut handle: HANDLE = std::ptr::null_mut();
    let result = unsafe {
        NtCreateFile(
            &mut handle,
            0x0010_0000
                | 0x0000_0080
                | 0x0000_0001
                | if authority {
                    0x0001_0000 | 0x0000_0100 | 0x0000_0002 | 0x0000_0004
                } else {
                    0
                },
            &mut attributes,
            &mut status,
            std::ptr::null_mut(),
            0,
            if authority { 0x1 } else { 0x1 | 0x2 | 0x4 },
            disposition,
            0x40 | 0x20 | 0x0020_0000,
            std::ptr::null_mut(),
            0,
        )
    };
    if result < 0 {
        if disposition == 1 && matches!(result as u32, 0xC000_0034 | 0xC000_003A) {
            return Ok(None);
        }
        return Err(());
    }
    if handle.is_null() {
        return Err(());
    }
    if (disposition == 2 && status.information != 2)
        || (disposition == 1 && status.information != 1)
    {
        unsafe {
            drop(File::from_raw_handle(handle));
        }
        return Err(());
    }
    Ok(Some(unsafe { File::from_raw_handle(handle) }))
}

fn open_relative_directory_with_disposition(
    parent: &File,
    component: &Path,
    disposition: u32,
    write_access: bool,
    delete_access: bool,
) -> Result<(File, bool), ()> {
    let mut name = component.as_os_str().encode_wide().collect::<Vec<_>>();
    if name.is_empty()
        || name.iter().any(|value| *value == 0)
        || name.len() > (u16::MAX as usize / 2)
    {
        return Err(());
    }
    let mut unicode = UnicodeString {
        length: (name.len() * 2) as u16,
        maximum_length: (name.len() * 2) as u16,
        buffer: name.as_mut_ptr(),
    };
    let mut attributes = ObjectAttributes {
        length: std::mem::size_of::<ObjectAttributes>() as u32,
        root_directory: parent.as_raw_handle(),
        object_name: &mut unicode,
        attributes: 0x40, // OBJ_CASE_INSENSITIVE
        security_descriptor: std::ptr::null_mut(),
        security_quality_of_service: std::ptr::null_mut(),
    };
    let mut status = IoStatusBlock {
        status: 0,
        information: 0,
    };
    let mut handle: HANDLE = std::ptr::null_mut();
    let desired_access = 0x0010_0000
        | 0x0000_0080
        | 0x0000_0001
        | if write_access {
            0x0000_0002 | 0x0000_0004
        } else {
            0
        }
        | if delete_access { 0x0001_0000 } else { 0 };
    let result = unsafe {
        NtCreateFile(
            &mut handle,
            desired_access,
            &mut attributes,
            &mut status,
            std::ptr::null_mut(),
            0,
            // A retained directory is immutable authority, not merely an
            // undeletable pathname.  Denying write sharing also prevents a
            // same-object FSCTL_SET_REPARSE_POINT conversion between identity
            // validation and a child-relative operation.
            if write_access || delete_access {
                0x1 // FILE_SHARE_READ; deliberately no write/delete
            } else {
                0x1 | 0x2 | 0x4 // transient identity probe
            },
            disposition,              // FILE_OPEN, FILE_CREATE, or FILE_OPEN_IF
            0x1 | 0x20 | 0x0020_0000, // DIRECTORY|SYNC_NONALERT|OPEN_REPARSE_POINT
            std::ptr::null_mut(),
            0,
        )
    };
    if result < 0 || handle.is_null() {
        return Err(());
    }
    // FILE_CREATED is 2; FILE_OPENED is 1. Any other success information is
    // outside this narrow authority contract.
    if status.information != 1 && status.information != 2 {
        unsafe {
            drop(File::from_raw_handle(handle));
        }
        return Err(());
    }
    Ok((
        unsafe { File::from_raw_handle(handle) },
        status.information == 2,
    ))
}

pub(super) fn rename_relative(
    file: &File,
    destination_parent: &File,
    name: &Path,
    replace: bool,
) -> Result<(), ()> {
    let wide = name.as_os_str().encode_wide().collect::<Vec<_>>();
    if wide.is_empty()
        || wide.iter().any(|value| *value == 0)
        || wide.len() > (u32::MAX as usize / 2)
    {
        return Err(());
    }
    // FILE_RENAME_INFO has an architecture-aligned HANDLE following its
    // BOOLEAN/DWORD union, then a DWORD length and an inline UTF-16 name.
    let pointer = std::mem::size_of::<HANDLE>();
    let root_offset = (4 + pointer - 1) & !(pointer - 1);
    let length_offset = root_offset + pointer;
    let name_offset = length_offset + 4;
    let mut information = vec![0u8; name_offset + wide.len() * 2];
    // FileRenameInfoEx interprets the first DWORD as flags. POSIX semantics is
    // required for a true pinned replacement: it permits the retained prior
    // handle to deny FILE_SHARE_DELETE while the temporary handle atomically
    // replaces its directory entry. Without this flag legacy rename fails with
    // a sharing violation, which tempts callers into releasing prior authority.
    let flags = if replace { 0x1 | 0x2 } else { 0 }; // REPLACE_IF_EXISTS|POSIX_SEMANTICS
    information[..4].copy_from_slice(&(flags as u32).to_ne_bytes());
    information[root_offset..root_offset + pointer]
        .copy_from_slice(&(destination_parent.as_raw_handle() as usize).to_ne_bytes());
    information[length_offset..name_offset]
        .copy_from_slice(&((wide.len() * 2) as u32).to_ne_bytes());
    for (index, value) in wide.iter().enumerate() {
        information[name_offset + index * 2..name_offset + index * 2 + 2]
            .copy_from_slice(&value.to_le_bytes());
    }
    if unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileRenameInfoEx,
            information.as_ptr() as *const c_void,
            information.len() as u32,
        )
    } == 0
    {
        return Err(());
    }
    Ok(())
}

pub(super) fn link_relative(file: &File, destination_parent: &File, name: &Path) -> Result<(), ()> {
    let wide = name.as_os_str().encode_wide().collect::<Vec<_>>();
    if wide.is_empty()
        || wide.iter().any(|value| *value == 0)
        || wide.len() > (u32::MAX as usize / 2)
    {
        return Err(());
    }
    let pointer = std::mem::size_of::<HANDLE>();
    let root_offset = (4 + pointer - 1) & !(pointer - 1);
    let length_offset = root_offset + pointer;
    let name_offset = length_offset + 4;
    let mut information = vec![0u8; name_offset + wide.len() * 2];
    information[root_offset..root_offset + pointer]
        .copy_from_slice(&(destination_parent.as_raw_handle() as usize).to_ne_bytes());
    information[length_offset..name_offset]
        .copy_from_slice(&((wide.len() * 2) as u32).to_ne_bytes());
    for (index, value) in wide.iter().enumerate() {
        information[name_offset + index * 2..name_offset + index * 2 + 2]
            .copy_from_slice(&value.to_le_bytes());
    }
    let mut status = IoStatusBlock {
        status: 0,
        information: 0,
    };
    if unsafe {
        NtSetInformationFile(
            file.as_raw_handle(),
            &mut status,
            information.as_mut_ptr() as *mut c_void,
            information.len() as u32,
            11,
        )
    } < 0
    {
        return Err(());
    }
    Ok(())
}

pub(super) fn delete_on_close(file: &File) -> Result<(), ()> {
    let value = [1u8];
    if unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileDispositionInfo,
            value.as_ptr() as *const c_void,
            value.len() as u32,
        )
    } == 0
    {
        return Err(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::windows::fs::OpenOptionsExt;

    fn fixture(label: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "opencode-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        root
    }
    fn directory(path: &Path) -> File {
        std::fs::OpenOptions::new()
            .access_mode(0x0010_0000 | 0x80 | 0x1 | 0x2 | 0x4)
            .share_mode(0x1 | 0x2)
            .custom_flags(0x0200_0000 | 0x0020_0000)
            .open(path)
            .unwrap()
    }

    #[test]
    fn exclusive_child_is_retained_from_creation_through_identity() {
        let root = fixture("relative-directory");
        let parent = directory(&root);
        let child = create_relative_directory(&parent, Path::new("child")).unwrap();
        let expected = file_identity(&child).unwrap();
        assert_eq!(
            file_identity(&probe_relative_directory(&parent, Path::new("child")).unwrap()).unwrap(),
            expected
        );
        assert!(std::fs::rename(root.join("child"), root.join("swapped")).is_err());
        drop(child);
        drop(parent);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preexisting_child_is_opened_and_retained_in_one_relative_operation() {
        let root = fixture("relative-preexisting-directory");
        std::fs::create_dir(root.join("child")).unwrap();
        let parent = directory(&root);
        let (child, created) = open_relative_directory(&parent, Path::new("child"), false).unwrap();
        assert!(!created);
        let expected = file_identity(&child).unwrap();
        assert_eq!(
            file_identity(&probe_relative_directory(&parent, Path::new("child")).unwrap()).unwrap(),
            expected
        );
        assert!(std::fs::rename(root.join("child"), root.join("swapped")).is_err());
        drop(child);
        drop(parent);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pinned_file_publish_and_restore_keep_exact_identities() {
        let root = fixture("atomic-file");
        let parent = directory(&root);
        std::fs::write(root.join("auth.json"), b"prior").unwrap();
        let prior = open_relative_file(&parent, Path::new("auth.json")).unwrap();
        let prior_id = file_identity(&prior).unwrap();
        link_relative(&prior, &parent, Path::new("backup")).unwrap();
        let mut temporary = create_relative_file(&parent, Path::new("temporary")).unwrap();
        temporary.write_all(b"next").unwrap();
        temporary.sync_all().unwrap();
        let next_id = file_identity(&temporary).unwrap();
        rename_relative(&temporary, &parent, Path::new("auth.json"), true).unwrap();
        assert_eq!(
            file_identity(&probe_relative_file(&parent, Path::new("auth.json")).unwrap()).unwrap(),
            next_id
        );
        rename_relative(&temporary, &parent, Path::new("quarantine"), false).unwrap();
        link_relative(&prior, &parent, Path::new("auth.json")).unwrap();
        assert_eq!(
            file_identity(&probe_relative_file(&parent, Path::new("auth.json")).unwrap()).unwrap(),
            prior_id
        );
        delete_on_close(&temporary).unwrap();
        drop(temporary);
        drop(prior);
        drop(parent);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn exclusive_publish_never_replaces_a_racing_successor() {
        let root = fixture("exclusive-file");
        let parent = directory(&root);
        let mut temporary = create_relative_file(&parent, Path::new("temporary")).unwrap();
        temporary.write_all(b"attempt").unwrap();
        std::fs::write(root.join("auth.json"), b"successor").unwrap();
        assert!(rename_relative(&temporary, &parent, Path::new("auth.json"), false).is_err());
        assert_eq!(std::fs::read(root.join("auth.json")).unwrap(), b"successor");
        delete_on_close(&temporary).unwrap();
        drop(temporary);
        drop(parent);
        std::fs::remove_dir_all(root).unwrap();
    }
}
