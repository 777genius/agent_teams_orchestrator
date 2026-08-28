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

// NtCreateFile resolves one child relative to a retained directory and returns
// that exact object. Existing components are tried with FILE_OPEN before any
// FILE_CREATE: create-capable FILE_OPEN_IF is never used to traverse existing
// common ancestors. If a competing creator wins after the absence result, our
// FILE_CREATE fails with a collision and the competing object is not adopted.
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
    status: NtStatus,
    information: usize,
}

type NtStatus = i32;

fn nt_success(status: NtStatus) -> bool {
    status >= 0
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
    ) -> NtStatus;
    fn NtSetInformationFile(
        file_handle: HANDLE,
        io_status_block: *mut IoStatusBlock,
        file_information: *mut c_void,
        length: u32,
        file_information_class: i32,
    ) -> NtStatus;
    fn NtFlushBuffersFile(file_handle: HANDLE, io_status_block: *mut IoStatusBlock) -> NtStatus;
    fn NtQueryVolumeInformationFile(
        file_handle: HANDLE,
        io_status_block: *mut IoStatusBlock,
        fs_information: *mut c_void,
        length: u32,
        fs_information_class: i32,
    ) -> NtStatus;
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
    ) -> NtStatus;
}

pub(super) fn flush_directory(directory: &File) -> Result<(), ()> {
    let mut status = IoStatusBlock {
        status: 0,
        information: 0,
    };
    let result = unsafe { NtFlushBuffersFile(directory.as_raw_handle(), &mut status) };
    if !nt_success(result) || !nt_success(status.status) {
        return Err(());
    }
    Ok(())
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
    open_relative_directory_kind(parent, component, create, false)
}

/// Retain an ancestor for handle-relative traversal without taking exclusive
/// write-sharing custody over the entire subtree. Delete sharing remains
/// denied, so the ancestor itself still cannot be renamed or replaced.
pub(super) fn open_relative_directory_for_traversal(
    parent: &File,
    component: &Path,
    create: bool,
) -> Result<(File, bool), ()> {
    open_relative_directory_kind(parent, component, create, true)
}

fn open_relative_directory_kind(
    parent: &File,
    component: &Path,
    create: bool,
    common_ancestor: bool,
) -> Result<(File, bool), ()> {
    // A create-enabled traversal handle needs FILE_ADD_SUBDIRECTORY for a
    // possibly missing next component, but shares writes so sibling roots can
    // coexist. The final owned root always retains mutation authority and
    // deliberately denies write/delete sharing.
    let write_access = !common_ancestor || create;
    if let Some((file, _)) = open_relative_directory_with_disposition(
        parent,
        component,
        1,
        write_access,
        false,
        common_ancestor,
    )? {
        return Ok((file, false));
    }
    if !create {
        return Err(());
    }
    open_relative_directory_with_disposition(
        parent,
        component,
        2,
        write_access,
        false,
        common_ancestor,
    )?
    .ok_or(())
}

pub(super) fn create_relative_directory(parent: &File, component: &Path) -> Result<File, ()> {
    let (file, created) =
        open_relative_directory_with_disposition(parent, component, 2, true, true, false)?
            .ok_or(())?;
    if !created {
        return Err(());
    }
    Ok(file)
}

pub(super) fn probe_relative_directory(parent: &File, component: &Path) -> Result<File, ()> {
    let (file, created) =
        open_relative_directory_with_disposition(parent, component, 1, false, false, false)?
            .ok_or(())?;
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
        open_relative_directory_with_disposition(parent, component, 1, true, true, false)?
            .ok_or(())?;
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

/// Retains an existing file's identity while permitting the database owner to
/// keep writing it. Delete sharing remains denied, so the pathname cannot be
/// replaced before the retained authority closes.
pub(super) fn pin_relative_writable_file(parent: &File, component: &Path) -> Result<File, ()> {
    open_relative_file_with_sharing(parent, component, 0x1 | 0x2)?.ok_or(())
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

fn open_relative_file_with_sharing(
    parent: &File,
    component: &Path,
    sharing: u32,
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
            0x0010_0000 | 0x0000_0080 | 0x0000_0001,
            &mut attributes,
            &mut status,
            std::ptr::null_mut(),
            0,
            sharing,
            1, // FILE_OPEN
            0x40 | 0x20 | 0x0020_0000,
            std::ptr::null_mut(),
            0,
        )
    };
    if result < 0 || handle.is_null() || status.information != 1 {
        if !handle.is_null() {
            unsafe { drop(File::from_raw_handle(handle)) };
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
    common_ancestor: bool,
) -> Result<Option<(File, bool)>, ()> {
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
            if common_ancestor {
                0x1 | 0x2 // common traversal anchor; deliberately no delete
            } else if write_access || delete_access {
                0x1 // owned authority; deliberately no write/delete
            } else {
                0x1 | 0x2 | 0x4 // transient identity probe
            },
            disposition,              // FILE_OPEN or FILE_CREATE; never FILE_OPEN_IF
            0x1 | 0x20 | 0x0020_0000, // DIRECTORY|SYNC_NONALERT|OPEN_REPARSE_POINT
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
    // FILE_CREATED is 2; FILE_OPENED is 1. The result must match the requested
    // disposition so a successful create can never be mistaken for an open.
    if (disposition == 1 && status.information != 1)
        || (disposition == 2 && status.information != 2)
    {
        unsafe {
            drop(File::from_raw_handle(handle));
        }
        return Err(());
    }
    Ok(Some((
        unsafe { File::from_raw_handle(handle) },
        status.information == 2,
    )))
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
    let mut information =
        RenameInformation::new(destination_parent.as_raw_handle(), &wide, replace)?;
    // Use the SDK-backed information class with the documented extended
    // FILE_RENAME_INFO payload. The aligned allocation below is byte-exact on
    // both supported 64-bit Windows ABIs.
    if unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileRenameInfoEx,
            information.as_mut_ptr(),
            information.byte_len,
        )
    } == 0
    {
        return Err(());
    }
    Ok(())
}

const RENAME_FLAGS_OFFSET: usize = 0;
const RENAME_ROOT_OFFSET: usize = 8;
const RENAME_LENGTH_OFFSET: usize = 16;
const RENAME_NAME_OFFSET: usize = 20;

// Vec<usize> gives the variable-sized FILE_RENAME_INFORMATION_EX allocation
// the alignment of HANDLE on both supported Windows ABIs. The byte length
// passed to Windows excludes only the allocation's trailing word padding.
struct RenameInformation {
    storage: Vec<usize>,
    byte_len: u32,
}

impl RenameInformation {
    fn new(destination_parent: HANDLE, wide: &[u16], replace: bool) -> Result<Self, ()> {
        if std::mem::size_of::<HANDLE>() != 8
            || std::mem::align_of::<usize>() < std::mem::align_of::<HANDLE>()
        {
            return Err(());
        }
        let name_bytes = wide.len().checked_mul(2).ok_or(())?;
        let byte_len = RENAME_NAME_OFFSET.checked_add(name_bytes).ok_or(())?;
        let byte_len = u32::try_from(byte_len).map_err(|_| ())?;
        let word = std::mem::size_of::<usize>();
        let words = (byte_len as usize).checked_add(word - 1).ok_or(())? / word;
        let mut storage = vec![0usize; words];
        let bytes = unsafe {
            std::slice::from_raw_parts_mut(storage.as_mut_ptr() as *mut u8, words * word)
        };
        // POSIX semantics permits replacement while the exact prior object is
        // retained without FILE_SHARE_DELETE. Never weaken this to legacy
        // replace semantics or release that retained authority.
        let flags: u32 = if replace { 0x1 | 0x2 } else { 0 };
        bytes[RENAME_FLAGS_OFFSET..RENAME_FLAGS_OFFSET + 4].copy_from_slice(&flags.to_ne_bytes());
        bytes[RENAME_ROOT_OFFSET..RENAME_ROOT_OFFSET + 8]
            .copy_from_slice(&(destination_parent as usize).to_ne_bytes());
        bytes[RENAME_LENGTH_OFFSET..RENAME_NAME_OFFSET]
            .copy_from_slice(&(name_bytes as u32).to_ne_bytes());
        for (index, value) in wide.iter().enumerate() {
            bytes[RENAME_NAME_OFFSET + index * 2..RENAME_NAME_OFFSET + index * 2 + 2]
                .copy_from_slice(&value.to_le_bytes());
        }
        Ok(Self { storage, byte_len })
    }

    fn as_mut_ptr(&mut self) -> *mut c_void {
        self.storage.as_mut_ptr() as *mut c_void
    }
}

pub(super) fn link_relative(file: &File, destination_parent: &File, name: &Path) -> Result<(), ()> {
    let wide = name.as_os_str().encode_wide().collect::<Vec<_>>();
    if wide.is_empty()
        || wide.iter().any(|value| *value == 0)
        || wide.len() > (u32::MAX as usize / 2)
    {
        return Err(());
    }
    let mut information = LinkInformation::new(destination_parent.as_raw_handle(), &wide)?;
    let mut status = IoStatusBlock {
        status: 0,
        information: 0,
    };
    let result = unsafe {
        NtSetInformationFile(
            file.as_raw_handle(),
            &mut status,
            information.as_mut_ptr(),
            information.byte_len,
            11,
        )
    };
    if !nt_success(result) || !nt_success(status.status) {
        return Err(());
    }
    Ok(())
}

const LINK_REPLACE_OFFSET: usize = 0;
const LINK_ROOT_OFFSET: usize = 8;
const LINK_LENGTH_OFFSET: usize = 16;
const LINK_NAME_OFFSET: usize = 20;

// FILE_LINK_INFORMATION has HANDLE alignment on both Windows x64 and ARM64.
// Vec<u8> does not promise that alignment even when a particular allocator
// happens to return an aligned address.
struct LinkInformation {
    storage: Vec<usize>,
    byte_len: u32,
}

impl LinkInformation {
    fn new(destination_parent: HANDLE, wide: &[u16]) -> Result<Self, ()> {
        if std::mem::size_of::<HANDLE>() != 8
            || std::mem::align_of::<usize>() < std::mem::align_of::<HANDLE>()
        {
            return Err(());
        }
        let name_bytes = wide.len().checked_mul(2).ok_or(())?;
        let byte_len = LINK_NAME_OFFSET.checked_add(name_bytes).ok_or(())?;
        let byte_len = u32::try_from(byte_len).map_err(|_| ())?;
        let word = std::mem::size_of::<usize>();
        let words = (byte_len as usize).checked_add(word - 1).ok_or(())? / word;
        let mut storage = vec![0usize; words];
        let bytes = unsafe {
            std::slice::from_raw_parts_mut(storage.as_mut_ptr() as *mut u8, words * word)
        };
        bytes[LINK_REPLACE_OFFSET] = 0;
        bytes[LINK_ROOT_OFFSET..LINK_ROOT_OFFSET + 8]
            .copy_from_slice(&(destination_parent as usize).to_ne_bytes());
        bytes[LINK_LENGTH_OFFSET..LINK_NAME_OFFSET]
            .copy_from_slice(&(name_bytes as u32).to_ne_bytes());
        for (index, value) in wide.iter().enumerate() {
            bytes[LINK_NAME_OFFSET + index * 2..LINK_NAME_OFFSET + index * 2 + 2]
                .copy_from_slice(&value.to_le_bytes());
        }
        Ok(Self { storage, byte_len })
    }

    fn as_mut_ptr(&mut self) -> *mut c_void {
        self.storage.as_mut_ptr() as *mut c_void
    }
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
        // The authority intentionally admits local NTFS only. Hosted Windows
        // runners may point TEMP at the ReFS checkout volume, so use the
        // per-user LocalAppData temp root on the production profile volume.
        let base = std::path::PathBuf::from(
            std::env::var_os("LOCALAPPDATA").expect("LOCALAPPDATA is required on Windows"),
        )
        .join("Temp");
        assert!(base.is_absolute());
        let root = base.join(format!(
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
        let directory = std::fs::OpenOptions::new()
            .access_mode(0x0010_0000 | 0x80 | 0x1 | 0x2 | 0x4)
            .share_mode(0x1 | 0x2)
            .custom_flags(0x0200_0000 | 0x0020_0000)
            .open(path)
            .unwrap();
        validate_local_ntfs(&directory).expect("Windows authority fixtures require local NTFS");
        directory
    }

    #[test]
    fn fixture_volume_matches_production_ntfs_contract() {
        let root = fixture("ntfs-contract");
        let parent = directory(&root);
        drop(parent);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn windows_ffi_layouts_match_both_supported_64_bit_abis() {
        assert_eq!(std::mem::size_of::<FILE_ID_INFO>(), 24);
        assert_eq!(std::mem::align_of::<FILE_ID_INFO>(), 8);
        assert_eq!(std::mem::size_of::<UnicodeString>(), 16);
        assert_eq!(std::mem::align_of::<UnicodeString>(), 8);
        assert_eq!(std::mem::size_of::<ObjectAttributes>(), 48);
        assert_eq!(std::mem::align_of::<ObjectAttributes>(), 8);
        assert_eq!(std::mem::size_of::<IoStatusBlock>(), 16);
        assert_eq!(std::mem::align_of::<IoStatusBlock>(), 8);
        assert_eq!(std::mem::size_of::<FileFsDeviceInformation>(), 8);
        assert_eq!(std::mem::align_of::<FileFsDeviceInformation>(), 4);
    }

    #[test]
    fn rename_information_ex_is_handle_aligned_and_byte_exact() {
        assert_eq!(RENAME_FLAGS_OFFSET, 0);
        assert_eq!(RENAME_ROOT_OFFSET, 8);
        assert_eq!(RENAME_LENGTH_OFFSET, 16);
        assert_eq!(RENAME_NAME_OFFSET, 20);

        let destination = 0x0102_0304_0506_0708usize as HANDLE;
        let wide = [b'A' as u16, 0xd83d, 0xde80];
        let information = RenameInformation::new(destination, &wide, true).unwrap();
        assert_eq!(
            information.storage.as_ptr() as usize % std::mem::align_of::<HANDLE>(),
            0
        );
        assert_eq!(
            information.byte_len as usize,
            RENAME_NAME_OFFSET + wide.len() * 2
        );

        let bytes = unsafe {
            std::slice::from_raw_parts(
                information.storage.as_ptr() as *const u8,
                information.byte_len as usize,
            )
        };
        assert_eq!(
            &bytes[RENAME_FLAGS_OFFSET..RENAME_FLAGS_OFFSET + 4],
            &(0x1u32 | 0x2).to_ne_bytes()
        );
        assert_eq!(
            &bytes[RENAME_ROOT_OFFSET..RENAME_ROOT_OFFSET + 8],
            &(destination as usize).to_ne_bytes()
        );
        assert_eq!(
            &bytes[RENAME_LENGTH_OFFSET..RENAME_NAME_OFFSET],
            &((wide.len() * 2) as u32).to_ne_bytes()
        );
        let expected_name = wide
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect::<Vec<_>>();
        assert_eq!(&bytes[RENAME_NAME_OFFSET..], expected_name.as_slice());
    }

    #[test]
    fn link_information_is_handle_aligned_and_byte_exact() {
        assert_eq!(LINK_REPLACE_OFFSET, 0);
        assert_eq!(LINK_ROOT_OFFSET, 8);
        assert_eq!(LINK_LENGTH_OFFSET, 16);
        assert_eq!(LINK_NAME_OFFSET, 20);

        let destination = 0x0102_0304_0506_0708usize as HANDLE;
        let wide = [b'A' as u16, 0xd83d, 0xde80];
        let information = LinkInformation::new(destination, &wide).unwrap();
        assert_eq!(
            information.storage.as_ptr() as usize % std::mem::align_of::<HANDLE>(),
            0
        );
        assert_eq!(
            information.byte_len as usize,
            LINK_NAME_OFFSET + wide.len() * 2
        );
        let bytes = unsafe {
            std::slice::from_raw_parts(
                information.storage.as_ptr() as *const u8,
                information.byte_len as usize,
            )
        };
        assert_eq!(bytes[LINK_REPLACE_OFFSET], 0);
        assert_eq!(
            &bytes[LINK_ROOT_OFFSET..LINK_ROOT_OFFSET + 8],
            &(destination as usize).to_ne_bytes()
        );
        assert_eq!(
            &bytes[LINK_LENGTH_OFFSET..LINK_NAME_OFFSET],
            &(wide.len() as u32 * 2).to_ne_bytes()
        );
    }

    #[test]
    fn nt_directory_flush_accepts_a_retained_ntfs_directory() {
        let root = fixture("directory-flush");
        let parent = directory(&root);
        flush_directory(&parent).unwrap();
        drop(parent);
        std::fs::remove_dir_all(root).unwrap();
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
    fn file_create_collision_never_adopts_a_competing_directory() {
        let root = fixture("relative-directory-collision");
        std::fs::create_dir(root.join("child")).unwrap();
        let parent = directory(&root);
        let expected =
            file_identity(&probe_relative_directory(&parent, Path::new("child")).unwrap()).unwrap();
        assert!(create_relative_directory(&parent, Path::new("child")).is_err());
        assert_eq!(
            file_identity(&probe_relative_directory(&parent, Path::new("child")).unwrap()).unwrap(),
            expected
        );
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
    fn writable_pin_allows_database_writes_but_denies_replacement() {
        let root = fixture("writable-pin");
        let parent = directory(&root);
        std::fs::write(root.join("passive.sqlite3"), b"before").unwrap();
        let retained = pin_relative_writable_file(&parent, Path::new("passive.sqlite3")).unwrap();
        let mut writer = std::fs::OpenOptions::new()
            .write(true)
            .share_mode(0x1 | 0x2 | 0x4)
            .open(root.join("passive.sqlite3"))
            .unwrap();
        writer.write_all(b"after").unwrap();
        writer.sync_all().unwrap();
        assert!(std::fs::rename(root.join("passive.sqlite3"), root.join("replaced")).is_err());
        drop(writer);
        drop(retained);
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
