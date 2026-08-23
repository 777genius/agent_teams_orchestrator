use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{self, Read, Seek, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::{FileExt, MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};
use windows_sys::Win32::Storage::FileSystem::{
    GetDriveTypeW, GetVolumeInformationW, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
};
use windows_sys::Win32::System::WindowsProgramming::DRIVE_FIXED;

const MAX_WIRE: usize = 64 * 1024;

fn valid_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()
            }
        })
}

fn encode_base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let value = ((chunk[0] as u32) << 16)
            | ((chunk.get(1).copied().unwrap_or(0) as u32) << 8)
            | chunk.get(2).copied().unwrap_or(0) as u32;
        output.push(TABLE[((value >> 18) & 63) as usize] as char);
        output.push(TABLE[((value >> 12) & 63) as usize] as char);
        output.push(if chunk.len() > 1 {
            TABLE[((value >> 6) & 63) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            TABLE[(value & 63) as usize] as char
        } else {
            '='
        });
    }
    output
}

fn decode_bounded_base64(value: &str) -> Result<Vec<u8>, &'static str> {
    if value.len() > 60 * 1024 || value.len() % 4 != 0 || !value.is_ascii() {
        return Err("FILE_REJECTED");
    }
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(value.len() / 4 * 3);
    for (offset, chunk) in bytes.chunks_exact(4).enumerate() {
        let last = offset + 1 == bytes.len() / 4;
        let digit = |byte: u8| -> Option<u8> {
            match byte {
                b'A'..=b'Z' => Some(byte - b'A'),
                b'a'..=b'z' => Some(byte - b'a' + 26),
                b'0'..=b'9' => Some(byte - b'0' + 52),
                b'+' => Some(62),
                b'/' => Some(63),
                _ => None,
            }
        };
        let a = digit(chunk[0]).ok_or("FILE_REJECTED")?;
        let b = digit(chunk[1]).ok_or("FILE_REJECTED")?;
        let c = if chunk[2] == b'=' {
            if !last || chunk[3] != b'=' {
                return Err("FILE_REJECTED");
            }
            0
        } else {
            digit(chunk[2]).ok_or("FILE_REJECTED")?
        };
        let d = if chunk[3] == b'=' {
            if !last {
                return Err("FILE_REJECTED");
            }
            0
        } else {
            digit(chunk[3]).ok_or("FILE_REJECTED")?
        };
        if (chunk[2] == b'=' && b & 0x0f != 0)
            || (chunk[3] == b'=' && chunk[2] != b'=' && c & 0x03 != 0)
        {
            return Err("FILE_REJECTED");
        }
        output.push((a << 2) | (b >> 4));
        if chunk[2] != b'=' {
            output.push((b << 4) | (c >> 2));
        }
        if chunk[3] != b'=' {
            output.push((c << 6) | d);
        }
    }
    if output.len() > 44 * 1024 {
        return Err("FILE_REJECTED");
    }
    Ok(output)
}

fn reserved_device(component: &str) -> bool {
    let stem = component.split('.').next().unwrap_or(component);
    let folded = stem.to_ascii_uppercase();
    matches!(folded.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$")
        || ((folded.starts_with("COM") || folded.starts_with("LPT"))
            && matches!(
                &folded[3..],
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            ))
}

fn valid_component(component: &str) -> bool {
    !component.is_empty()
        && component != "."
        && component != ".."
        && !matches!(component.chars().last(), Some('.' | ' '))
        && !component
            .chars()
            .any(|c| c == '\0' || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
        && !reserved_device(component)
}

fn valid_root_input(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 3
        || bytes.len() > 32_767
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || bytes[2] != b'\\'
        || value.starts_with("\\\\")
        || value.contains('/')
        || value[2..].contains(':')
    {
        return false;
    }
    let components = value[3..].split('\\').collect::<Vec<_>>();
    components.iter().enumerate().all(|(index, component)| {
        (component.is_empty() && index + 1 == components.len()) || valid_component(component)
    })
}

struct HeldComponent {
    path: PathBuf,
    handle: std::fs::File,
    identity: crate::windows_identity::FileIdentity,
}

struct RetainedWindowsRoot {
    target: PathBuf,
    held: Vec<HeldComponent>,
    pinned: Vec<std::fs::File>,
    pinned_directories: Vec<(String, std::fs::File, crate::windows_identity::FileIdentity)>,
    pinned_files: Vec<(
        String,
        std::fs::File,
        crate::windows_identity::FileIdentity,
        u64,
        bool,
    )>,
    materialization_published: bool,
    materialization_root: Option<String>,
    materialization_rolled_back: bool,
    publication: Option<AtomicPublication>,
    namespace_directories: Vec<(String, std::fs::File, crate::windows_identity::FileIdentity)>,
    namespace_handles: Vec<(
        String,
        String,
        std::fs::File,
        crate::windows_identity::FileIdentity,
        bool,
    )>,
}

struct AtomicPublication {
    final_name: String,
    temporary_name: String,
    backup_name: String,
    quarantine_name: String,
    temporary: Option<std::fs::File>,
    temporary_identity: crate::windows_identity::FileIdentity,
    prior: Option<std::fs::File>,
    prior_identity: Option<crate::windows_identity::FileIdentity>,
    stage: AtomicPublicationStage,
    backup_created: bool,
    recovery_name: String,
    expected_prior: String,
    recovery: Option<std::fs::File>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AtomicPublicationStage {
    Preparing,
    Temporary,
    PriorCaptured,
    Published,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct AtomicRecoveryRecord {
    version: u8,
    final_name: String,
    temporary_name: String,
    backup_name: String,
    quarantine_name: String,
    recovery_name: String,
    expected_prior: String,
    temporary_volume_serial: Option<String>,
    temporary_file_id: Option<String>,
    prior_volume_serial: Option<String>,
    prior_file_id: Option<String>,
    backup_volume_serial: Option<String>,
    backup_file_id: Option<String>,
    stage: String,
}

fn append_atomic_recovery_record(
    recovery: &mut std::fs::File,
    parent: &std::fs::File,
    record: &AtomicRecoveryRecord,
) -> Result<(), &'static str> {
    recovery
        .seek(std::io::SeekFrom::End(0))
        .map_err(|_| "RECOVERY_REQUIRED")?;
    serde_json::to_writer(&mut *recovery, record).map_err(|_| "RECOVERY_REQUIRED")?;
    recovery.write_all(b"\n").map_err(|_| "RECOVERY_REQUIRED")?;
    recovery.sync_all().map_err(|_| "RECOVERY_REQUIRED")?;
    parent.sync_all().map_err(|_| "RECOVERY_REQUIRED")?;
    Ok(())
}

fn open_volume_directory(path: &Path) -> Result<std::fs::File, &'static str> {
    std::fs::OpenOptions::new()
        .access_mode(0x0010_0000 | 0x0000_0080 | 0x0000_0001 | 0x0000_0002 | 0x0000_0004)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|_| "ROOT_REJECTED")
}

fn open_directory_probe(path: &Path) -> Result<std::fs::File, &'static str> {
    std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|_| "ROOT_REJECTED")
}

fn validate_retained_directory(
    handle: &std::fs::File,
    expected: crate::windows_identity::FileIdentity,
) -> Result<(), &'static str> {
    let metadata = handle.metadata().map_err(|_| "FILE_REJECTED")?;
    if !metadata.is_dir()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || crate::windows_identity::file_identity(handle).map_err(|_| "FILE_REJECTED")? != expected
    {
        return Err("FILE_REJECTED");
    }
    Ok(())
}

fn volume_root(target: &Path) -> Result<(PathBuf, Vec<u16>), &'static str> {
    if !target.is_absolute() {
        return Err("ROOT_REJECTED");
    }
    let prefix = match target.components().next() {
        Some(Component::Prefix(value)) => value.as_os_str(),
        _ => return Err("ROOT_REJECTED"),
    };
    let mut root = PathBuf::from(prefix);
    root.push("\\");
    let mut wide = root.as_os_str().encode_wide().collect::<Vec<_>>();
    wide.push(0);
    Ok((root, wide))
}

fn verify_ntfs(wide: &[u16]) -> Result<(), &'static str> {
    if unsafe { GetDriveTypeW(wide.as_ptr()) } != DRIVE_FIXED {
        return Err("ROOT_REJECTED");
    }
    let mut fs = [0u16; 32];
    if unsafe {
        GetVolumeInformationW(
            wide.as_ptr(),
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            fs.as_mut_ptr(),
            fs.len() as u32,
        )
    } == 0
    {
        return Err("ROOT_REJECTED");
    }
    let end = fs.iter().position(|v| *v == 0).unwrap_or(fs.len());
    if String::from_utf16_lossy(&fs[..end]) != "NTFS" {
        return Err("ROOT_REJECTED");
    }
    Ok(())
}

impl RetainedWindowsRoot {
    fn validate_namespace(&self) -> Result<(), &'static str> {
        let final_component = self.held.last().ok_or("ROOT_REJECTED")?;
        crate::windows_identity::validate_local_ntfs(&final_component.handle)
            .map_err(|_| "ROOT_REJECTED")?;
        for component in &self.held {
            let metadata = component.handle.metadata().map_err(|_| "ROOT_REJECTED")?;
            if !metadata.is_dir()
                || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
                || crate::windows_identity::file_identity(&component.handle)
                    .map_err(|_| "ROOT_REJECTED")?
                    != component.identity
            {
                return Err("ROOT_REJECTED");
            }
        }
        Ok(())
    }
    fn valid_namespace_path(value: &str) -> bool {
        value == "."
            || (value.len() <= 4096 && !value.is_empty() && value.split('/').all(valid_leaf))
    }

    fn namespace_parent(value: &str) -> Result<(&str, &str), &'static str> {
        if !Self::valid_namespace_path(value) || value == "." {
            return Err("LEAF_REJECTED");
        }
        Ok(value.rsplit_once('/').unwrap_or((".", value)))
    }

    fn namespace_directory(
        &mut self,
        key: &str,
    ) -> Result<(std::fs::File, crate::windows_identity::FileIdentity), &'static str> {
        self.validate_namespace()?;
        if !Self::valid_namespace_path(key) {
            return Err("LEAF_REJECTED");
        }
        if key == "." {
            let held = self.held.last().ok_or("ROOT_REJECTED")?;
            return Ok((
                held.handle.try_clone().map_err(|_| "ROOT_REJECTED")?,
                held.identity,
            ));
        }
        let mut parent = self
            .held
            .last()
            .ok_or("ROOT_REJECTED")?
            .handle
            .try_clone()
            .map_err(|_| "ROOT_REJECTED")?;
        let mut prefix = String::new();
        let mut identity = self.held.last().ok_or("ROOT_REJECTED")?.identity;
        for component in key.split('/') {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(component);
            if let Some((_, handle, expected)) = self
                .namespace_directories
                .iter()
                .find(|(candidate, _, _)| candidate == &prefix)
            {
                validate_retained_directory(handle, *expected)?;
                parent = handle.try_clone().map_err(|_| "FILE_REJECTED")?;
                identity = *expected;
                continue;
            }
            let (opened, created) = crate::windows_identity::open_relative_directory(
                &parent,
                Path::new(component),
                false,
            )
            .map_err(|_| "FILE_REJECTED")?;
            if created {
                return Err("FILE_REJECTED");
            }
            let metadata = opened.metadata().map_err(|_| "FILE_REJECTED")?;
            if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            {
                return Err("FILE_REJECTED");
            }
            identity =
                crate::windows_identity::file_identity(&opened).map_err(|_| "FILE_REJECTED")?;
            parent = opened.try_clone().map_err(|_| "FILE_REJECTED")?;
            self.namespace_directories
                .push((prefix.clone(), opened, identity));
        }
        Ok((parent, identity))
    }

    fn namespace_value(
        file: &std::fs::File,
        identity: crate::windows_identity::FileIdentity,
    ) -> Result<Value, &'static str> {
        let metadata = file.metadata().map_err(|_| "FILE_REJECTED")?;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("FILE_REJECTED");
        }
        Ok(
            json!({"volumeSerial":identity.0.to_string(),"fileId":identity.1.to_string(),
            "size":metadata.file_size().to_string(),"kind":if metadata.is_dir(){"directory"}else{"file"}}),
        )
    }

    fn namespace_stat(&mut self, path: &str) -> Result<Value, &'static str> {
        self.validate_namespace()?;
        if path == "." {
            let (file, identity) = self.namespace_directory(path)?;
            return Self::namespace_value(&file, identity);
        }
        if let Some((_, file, identity)) = self
            .namespace_directories
            .iter()
            .find(|(key, _, _)| key == path)
        {
            return Self::namespace_value(file, *identity);
        }
        if let Some((_, _, file, identity, _)) = self
            .namespace_handles
            .iter()
            .find(|(_, key, _, _, _)| key == path)
        {
            return Self::namespace_value(file, *identity);
        }
        let (parent_key, name) = Self::namespace_parent(path)?;
        let (parent, _) = self.namespace_directory(parent_key)?;
        if let Ok((file, created)) =
            crate::windows_identity::open_relative_directory(&parent, Path::new(name), false)
        {
            if created {
                return Err("FILE_REJECTED");
            }
            let identity =
                crate::windows_identity::file_identity(&file).map_err(|_| "FILE_REJECTED")?;
            return Self::namespace_value(&file, identity);
        }
        let file = crate::windows_identity::open_relative_file(&parent, Path::new(name))
            .map_err(|_| "NS_NOT_FOUND")?;
        let identity =
            crate::windows_identity::file_identity(&file).map_err(|_| "FILE_REJECTED")?;
        Self::namespace_value(&file, identity)
    }

    fn namespace_mkdir(&mut self, path: &str) -> Result<Value, &'static str> {
        let (parent_key, name) = Self::namespace_parent(path)?;
        let (parent, _) = self.namespace_directory(parent_key)?;
        if crate::windows_identity::probe_relative_directory(&parent, Path::new(name)).is_ok()
            || crate::windows_identity::probe_relative_file(&parent, Path::new(name)).is_ok()
        {
            return Err("NS_EXISTS");
        }
        let directory =
            crate::windows_identity::create_relative_directory(&parent, Path::new(name))
                .map_err(|_| "FILE_REJECTED")?;
        let identity =
            crate::windows_identity::file_identity(&directory).map_err(|_| "FILE_REJECTED")?;
        parent.sync_all().map_err(|_| "FILE_REJECTED")?;
        self.namespace_directories
            .push((path.to_string(), directory, identity));
        Ok(json!({}))
    }

    fn namespace_open(
        &mut self,
        path: &str,
        token: &str,
        mode: &str,
    ) -> Result<Value, &'static str> {
        if !valid_id(token)
            || self
                .namespace_handles
                .iter()
                .any(|(candidate, _, _, _, _)| candidate == token)
        {
            return Err("STATE_REJECTED");
        }
        let (file, identity, directory) = if mode == "directory" {
            let (file, identity) = self.namespace_directory(path)?;
            (file, identity, true)
        } else {
            let (parent_key, name) = Self::namespace_parent(path)?;
            let (parent, _) = self.namespace_directory(parent_key)?;
            let file = if mode == "create_file" {
                crate::windows_identity::create_relative_file(&parent, Path::new(name))
            } else if mode == "read" || mode == "readwrite" {
                crate::windows_identity::open_relative_file(&parent, Path::new(name))
            } else {
                return Err("STATE_REJECTED");
            }
            .map_err(|_| {
                if mode == "create_file" {
                    "NS_EXISTS"
                } else {
                    "NS_NOT_FOUND"
                }
            })?;
            let identity =
                crate::windows_identity::file_identity(&file).map_err(|_| "FILE_REJECTED")?;
            (file, identity, false)
        };
        let mut value = Self::namespace_value(&file, identity)?;
        value["token"] = json!(token);
        self.namespace_handles.push((
            token.to_string(),
            path.to_string(),
            file,
            identity,
            directory,
        ));
        Ok(value)
    }

    fn namespace_read(
        &self,
        token: &str,
        offset: u64,
        length: usize,
    ) -> Result<Value, &'static str> {
        self.validate_namespace()?;
        if length > 32 * 1024 {
            return Err("FILE_REJECTED");
        }
        let (_, _, file, identity, directory) = self
            .namespace_handles
            .iter()
            .find(|(candidate, _, _, _, _)| candidate == token)
            .ok_or("FILE_REJECTED")?;
        if *directory
            || crate::windows_identity::file_identity(file).map_err(|_| "FILE_REJECTED")?
                != *identity
        {
            return Err("FILE_REJECTED");
        }
        let mut bytes = vec![0u8; length];
        let count = file
            .seek_read(&mut bytes, offset)
            .map_err(|_| "FILE_REJECTED")?;
        bytes.truncate(count);
        Ok(json!({"content_base64":encode_base64(&bytes)}))
    }

    fn namespace_write(
        &mut self,
        token: &str,
        offset: u64,
        truncate: bool,
        content: &[u8],
    ) -> Result<Value, &'static str> {
        self.validate_namespace()?;
        let (_, _, file, identity, directory) = self
            .namespace_handles
            .iter_mut()
            .find(|(candidate, _, _, _, _)| candidate == token)
            .ok_or("FILE_REJECTED")?;
        if *directory
            || crate::windows_identity::file_identity(file).map_err(|_| "FILE_REJECTED")?
                != *identity
        {
            return Err("FILE_REJECTED");
        }
        if truncate {
            file.set_len(0).map_err(|_| "FILE_REJECTED")?;
        }
        let count = file
            .seek_write(content, offset)
            .map_err(|_| "FILE_REJECTED")?;
        if count != content.len() {
            return Err("FILE_REJECTED");
        }
        Ok(json!({"written":(offset + count as u64).to_string()}))
    }

    fn namespace_sync_handle(&self, token: &str) -> Result<Value, &'static str> {
        self.validate_namespace()?;
        let (_, _, file, identity, _) = self
            .namespace_handles
            .iter()
            .find(|(candidate, _, _, _, _)| candidate == token)
            .ok_or("FILE_REJECTED")?;
        if crate::windows_identity::file_identity(file).map_err(|_| "FILE_REJECTED")? != *identity {
            return Err("FILE_REJECTED");
        }
        file.sync_all().map_err(|_| "FILE_REJECTED")?;
        Ok(json!({}))
    }

    fn namespace_close_handle(&mut self, token: &str) -> Result<Value, &'static str> {
        let index = self
            .namespace_handles
            .iter()
            .position(|(candidate, _, _, _, _)| candidate == token)
            .ok_or("FILE_REJECTED")?;
        self.namespace_handles.remove(index);
        Ok(json!({}))
    }

    fn namespace_rename(&mut self, from: &str, to: &str) -> Result<Value, &'static str> {
        let (from_parent, from_name) = Self::namespace_parent(from)?;
        let (to_parent, to_name) = Self::namespace_parent(to)?;
        let (source_parent, _) = self.namespace_directory(from_parent)?;
        let (destination_parent, _) = self.namespace_directory(to_parent)?;
        let retained_index = self
            .namespace_directories
            .iter()
            .position(|(key, _, _)| key == from);
        let retained_handle_index = self
            .namespace_handles
            .iter()
            .position(|(_, key, _, _, _)| key == from);
        let source = if let Some(index) = retained_handle_index {
            self.namespace_handles[index]
                .2
                .try_clone()
                .map_err(|_| "FILE_REJECTED")?
        } else if let Some(index) = retained_index {
            self.namespace_directories.remove(index).1
        } else {
            match crate::windows_identity::open_relative_directory(
                &source_parent,
                Path::new(from_name),
                false,
            ) {
                Ok((file, false)) => file,
                _ => crate::windows_identity::open_relative_file(
                    &source_parent,
                    Path::new(from_name),
                )
                .map_err(|_| "FILE_REJECTED")?,
            }
        };
        let source_identity =
            crate::windows_identity::file_identity(&source).map_err(|_| "FILE_REJECTED")?;
        let source_is_directory = source.metadata().map_err(|_| "FILE_REJECTED")?.is_dir();
        if source_is_directory
            && (crate::windows_identity::probe_relative_directory(
                &destination_parent,
                Path::new(to_name),
            )
            .is_ok()
                || crate::windows_identity::probe_relative_file(
                    &destination_parent,
                    Path::new(to_name),
                )
                .is_ok())
        {
            return Err("NS_EXISTS");
        }
        crate::windows_identity::rename_relative(
            &source,
            &destination_parent,
            Path::new(to_name),
            !source_is_directory,
        )
        .map_err(|_| "FILE_REJECTED")?;
        source_parent.sync_all().map_err(|_| "FILE_REJECTED")?;
        if from_parent != to_parent {
            destination_parent.sync_all().map_err(|_| "FILE_REJECTED")?;
        }
        if source_is_directory {
            self.namespace_directories
                .push((to.to_string(), source, source_identity));
        }
        let descendant_prefix = format!("{from}/");
        for (_, key, _, _, _) in &mut self.namespace_handles {
            if key == from {
                *key = to.to_string();
            } else if let Some(suffix) = key.strip_prefix(&descendant_prefix) {
                *key = format!("{to}/{suffix}");
            }
        }
        for (key, _, _) in &mut self.namespace_directories {
            if let Some(suffix) = key.strip_prefix(&descendant_prefix) {
                *key = format!("{to}/{suffix}");
            }
        }
        Ok(json!({}))
    }

    fn namespace_unlink(&mut self, path: &str, directory: bool) -> Result<Value, &'static str> {
        let (parent_key, name) = Self::namespace_parent(path)?;
        let (parent, _) = self.namespace_directory(parent_key)?;
        let retained_index = self
            .namespace_directories
            .iter()
            .position(|(key, _, _)| key == path);
        let file = if directory && retained_index.is_some() {
            self.namespace_directories.remove(retained_index.unwrap()).1
        } else if directory {
            let (file, created) =
                crate::windows_identity::open_relative_directory(&parent, Path::new(name), false)
                    .map_err(|_| "FILE_REJECTED")?;
            if created {
                return Err("FILE_REJECTED");
            }
            file
        } else {
            crate::windows_identity::open_relative_file(&parent, Path::new(name))
                .map_err(|_| "FILE_REJECTED")?
        };
        crate::windows_identity::delete_on_close(&file).map_err(|_| {
            if directory {
                "NS_NOT_EMPTY"
            } else {
                "FILE_REJECTED"
            }
        })?;
        drop(file);
        parent.sync_all().map_err(|_| "FILE_REJECTED")?;
        self.namespace_directories
            .retain(|(key, _, _)| key != path && !key.starts_with(&format!("{path}/")));
        Ok(json!({}))
    }

    fn namespace_sync_directory(&mut self, path: &str) -> Result<Value, &'static str> {
        let (directory, identity) = self.namespace_directory(path)?;
        validate_retained_directory(&directory, identity)?;
        directory.sync_all().map_err(|_| "FILE_REJECTED")?;
        Ok(json!({}))
    }
    fn open(
        target: PathBuf,
        create: bool,
        durable: bool,
    ) -> Result<(Self, Vec<String>), &'static str> {
        if !valid_root_input(target.to_str().ok_or("ROOT_REJECTED")?) {
            return Err("ROOT_REJECTED");
        }
        let (root_path, wide) = volume_root(&target)?;
        verify_ntfs(&wide)?;
        let root_handle = open_volume_directory(&root_path)?;
        crate::windows_identity::validate_local_ntfs(&root_handle).map_err(|_| "ROOT_REJECTED")?;
        let root_meta = root_handle.metadata().map_err(|_| "ROOT_REJECTED")?;
        if !root_meta.is_dir() || root_meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("ROOT_REJECTED");
        }
        let root_identity =
            crate::windows_identity::file_identity(&root_handle).map_err(|_| "ROOT_REJECTED")?;
        let mut held = vec![HeldComponent {
            path: root_path,
            handle: root_handle,
            identity: root_identity,
        }];
        let mut cursor = root_path.clone();
        let mut created = Vec::new();
        for component in target.components() {
            if matches!(component, Component::Prefix(_) | Component::RootDir) {
                continue;
            }
            let parent = held.last().ok_or("ROOT_REJECTED")?;
            let (handle, was_created) = crate::windows_identity::open_relative_directory(
                &parent.handle,
                Path::new(component.as_os_str()),
                create,
            )
            .map_err(|_| "ROOT_REJECTED")?;
            cursor.push(component.as_os_str());
            if was_created {
                if durable {
                    parent.handle.sync_all().map_err(|_| "ROOT_REJECTED")?;
                }
                created.push(cursor.to_string_lossy().into_owned());
            }
            let metadata = handle.metadata().map_err(|_| "ROOT_REJECTED")?;
            if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            {
                return Err("ROOT_REJECTED");
            }
            let identity =
                crate::windows_identity::file_identity(&handle).map_err(|_| "ROOT_REJECTED")?;
            held.push(HeldComponent {
                path: cursor.clone(),
                handle,
                identity,
            });
        }
        let root = Self {
            target,
            held,
            pinned: Vec::new(),
            pinned_directories: Vec::new(),
            pinned_files: Vec::new(),
            materialization_published: false,
            materialization_root: None,
            materialization_rolled_back: false,
            publication: None,
            namespace_directories: Vec::new(),
            namespace_handles: Vec::new(),
        };
        root.validate()?;
        Ok((root, created))
    }

    fn validate(&self) -> Result<(), &'static str> {
        for component in &self.held {
            let held_meta = component.handle.metadata().map_err(|_| "ROOT_REJECTED")?;
            let named = open_directory_probe(&component.path)?;
            let named_meta = named.metadata().map_err(|_| "ROOT_REJECTED")?;
            if !held_meta.is_dir()
                || !named_meta.is_dir()
                || held_meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
                || named_meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
                || crate::windows_identity::file_identity(&component.handle)
                    .map_err(|_| "ROOT_REJECTED")?
                    != component.identity
                || crate::windows_identity::file_identity(&named).map_err(|_| "ROOT_REJECTED")?
                    != component.identity
            {
                return Err("ROOT_REJECTED");
            }
        }
        Ok(())
    }

    fn sync(&self) -> Result<(), &'static str> {
        self.validate()?;
        self.held
            .last()
            .ok_or("ROOT_REJECTED")?
            .handle
            .sync_all()
            .map_err(|_| "ROOT_REJECTED")
    }

    fn retained_directory(
        &self,
        key: &str,
    ) -> Result<(&std::fs::File, crate::windows_identity::FileIdentity), &'static str> {
        if key == "." {
            let component = self.held.last().ok_or("ROOT_REJECTED")?;
            return Ok((&component.handle, component.identity));
        }
        self.pinned_directories
            .iter()
            .find(|(candidate, _, _)| candidate == key)
            .map(|(_, handle, identity)| (handle, *identity))
            .ok_or("FILE_REJECTED")
    }

    fn open_child_directory(
        &mut self,
        parent_key: &str,
        key: &str,
        name: &str,
    ) -> Result<Value, &'static str> {
        if !valid_leaf(name)
            || !valid_materialization_key(key)
            || key
                != if parent_key == "." {
                    name.to_string()
                } else {
                    format!("{parent_key}/{name}")
                }
            || (parent_key != "." && !valid_materialization_key(parent_key))
            || self
                .pinned_directories
                .iter()
                .any(|(candidate, _, _)| candidate == key)
        {
            return Err("LEAF_REJECTED");
        }
        self.validate()?;
        let (parent, identity) = self.retained_directory(parent_key)?;
        validate_retained_directory(parent, identity)?;
        let (file, created) =
            crate::windows_identity::open_relative_directory(parent, Path::new(name), false)
                .map_err(|_| "FILE_REJECTED")?;
        if created {
            return Err("FILE_REJECTED");
        }
        let metadata = file.metadata().map_err(|_| "FILE_REJECTED")?;
        if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("FILE_REJECTED");
        }
        let identity =
            crate::windows_identity::file_identity(&file).map_err(|_| "FILE_REJECTED")?;
        self.pinned_directories
            .push((key.to_string(), file, identity));
        Ok(json!({"volumeSerial":identity.0.to_string(),"fileId":identity.1.to_string()}))
    }

    fn pin(
        &mut self,
        parent_key: &str,
        name: &str,
        _deny_writes: bool,
    ) -> Result<Value, &'static str> {
        if !valid_leaf(name) || (parent_key != "." && !valid_materialization_key(parent_key)) {
            return Err("LEAF_REJECTED");
        }
        self.validate()?;
        let (parent, identity) = self.retained_directory(parent_key)?;
        validate_retained_directory(parent, identity)?;
        // The retained relative open is no-follow and denies write/delete
        // sharing. The legacy PIN_REGULAR spelling remains wire-compatible;
        // all consumers now receive the stronger content-stable lease.
        let file = crate::windows_identity::open_relative_file(parent, Path::new(name))
            .map_err(|_| "FILE_REJECTED")?;
        let metadata = file.metadata().map_err(|_| "FILE_REJECTED")?;
        if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("FILE_REJECTED");
        }
        let identity =
            crate::windows_identity::file_identity(&file).map_err(|_| "FILE_REJECTED")?;
        let value = json!({"volumeSerial": identity.0.to_string(), "fileId": identity.1.to_string(), "size": metadata.file_size().to_string()});
        self.pinned.push(file);
        Ok(value)
    }

    fn create_directory(&mut self, name: &str) -> Result<Value, &'static str> {
        if !valid_leaf(name)
            || self.materialization_published
            || self.materialization_root.is_some()
            || self.materialization_rolled_back
        {
            return Err("LEAF_REJECTED");
        }
        self.validate()?;
        let parent = self
            .held
            .last()
            .ok_or("ROOT_REJECTED")?
            .handle
            .try_clone()
            .map_err(|_| "ROOT_REJECTED")?;
        let file = crate::windows_identity::create_relative_directory(&parent, Path::new(name))
            .map_err(|_| "FILE_REJECTED")?;
        let metadata = file.metadata().map_err(|_| "FILE_REJECTED")?;
        if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("FILE_REJECTED");
        }
        let identity =
            crate::windows_identity::file_identity(&file).map_err(|_| "FILE_REJECTED")?;
        self.pinned_directories
            .push((name.to_string(), file, identity));
        self.materialization_root = Some(name.to_string());
        parent.sync_all().map_err(|_| "ROOT_REJECTED")?;
        Ok(json!({"volumeSerial":identity.0.to_string(),"fileId":identity.1.to_string()}))
    }

    fn create_child_directory(
        &mut self,
        parent_key: &str,
        key: &str,
        name: &str,
    ) -> Result<Value, &'static str> {
        if !valid_leaf(name)
            || !valid_materialization_key(parent_key)
            || key != format!("{parent_key}/{name}")
            || !valid_materialization_key(key)
            || self.materialization_published
            || self
                .pinned_directories
                .iter()
                .any(|(candidate, _, _)| candidate == key)
        {
            return Err("LEAF_REJECTED");
        }
        self.validate()?;
        let parent = self
            .pinned_directories
            .iter()
            .find(|(candidate, _, _)| candidate == parent_key)
            .map(|(_, handle, identity)| (handle, *identity))
            .ok_or("FILE_REJECTED")?;
        validate_retained_directory(parent.0, parent.1)?;
        let parent = parent.0.try_clone().map_err(|_| "FILE_REJECTED")?;
        let file = crate::windows_identity::create_relative_directory(&parent, Path::new(name))
            .map_err(|_| "FILE_REJECTED")?;
        let metadata = file.metadata().map_err(|_| "FILE_REJECTED")?;
        if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("FILE_REJECTED");
        }
        let identity =
            crate::windows_identity::file_identity(&file).map_err(|_| "FILE_REJECTED")?;
        self.pinned_directories
            .push((key.to_string(), file, identity));
        parent.sync_all().map_err(|_| "ROOT_REJECTED")?;
        Ok(json!({"volumeSerial":identity.0.to_string(),"fileId":identity.1.to_string()}))
    }

    fn create_child_file(
        &mut self,
        parent_key: &str,
        key: &str,
        name: &str,
    ) -> Result<Value, &'static str> {
        if !valid_leaf(name)
            || !valid_materialization_key(parent_key)
            || key != format!("{parent_key}/{name}")
            || !valid_materialization_key(key)
            || self.materialization_published
            || self
                .pinned_files
                .iter()
                .any(|(candidate, _, _, _, _)| candidate == key)
        {
            return Err("LEAF_REJECTED");
        }
        self.validate()?;
        let parent = self
            .pinned_directories
            .iter()
            .find(|(candidate, _, _)| candidate == parent_key)
            .map(|(_, handle, identity)| (handle, *identity))
            .ok_or("FILE_REJECTED")?;
        validate_retained_directory(parent.0, parent.1)?;
        let parent = parent.0.try_clone().map_err(|_| "FILE_REJECTED")?;
        let file = crate::windows_identity::create_relative_file(&parent, Path::new(name))
            .map_err(|_| "FILE_REJECTED")?;
        let metadata = file.metadata().map_err(|_| "FILE_REJECTED")?;
        if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("FILE_REJECTED");
        }
        let identity =
            crate::windows_identity::file_identity(&file).map_err(|_| "FILE_REJECTED")?;
        self.pinned_files
            .push((key.to_string(), file, identity, 0, false));
        parent.sync_all().map_err(|_| "ROOT_REJECTED")?;
        Ok(json!({"volumeSerial":identity.0.to_string(),"fileId":identity.1.to_string()}))
    }

    fn write_child_file(
        &mut self,
        key: &str,
        offset: u64,
        content: &[u8],
        finish: bool,
    ) -> Result<Value, &'static str> {
        if !valid_materialization_key(key) || content.len() > 44 * 1024 {
            return Err("FILE_REJECTED");
        }
        self.validate()?;
        let (_, file, identity, written, finished) = self
            .pinned_files
            .iter_mut()
            .find(|(candidate, _, _, _, _)| candidate == key)
            .ok_or("FILE_REJECTED")?;
        if self.materialization_published
            || *finished
            || offset != *written
            || offset
                .checked_add(content.len() as u64)
                .ok_or("FILE_REJECTED")?
                > 16 * 1024 * 1024
            || crate::windows_identity::file_identity(file).map_err(|_| "FILE_REJECTED")?
                != *identity
        {
            return Err("FILE_REJECTED");
        }
        let mut done = 0usize;
        while done < content.len() {
            let count = file
                .seek_write(&content[done..], offset + done as u64)
                .map_err(|_| "FILE_REJECTED")?;
            if count == 0 {
                return Err("FILE_REJECTED");
            }
            done += count;
        }
        *written += done as u64;
        if finish {
            file.sync_all().map_err(|_| "FILE_REJECTED")?;
            let metadata = file.metadata().map_err(|_| "FILE_REJECTED")?;
            if !metadata.is_file()
                || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
                || metadata.file_size() != *written
                || crate::windows_identity::file_identity(file).map_err(|_| "FILE_REJECTED")?
                    != *identity
            {
                return Err("FILE_REJECTED");
            }
            *finished = true;
        }
        Ok(json!({"written":written.to_string(),"finished":finish}))
    }

    fn rename_directory(&mut self, from: &str, to: &str) -> Result<Value, &'static str> {
        if !valid_leaf(from)
            || !valid_leaf(to)
            || self.materialization_published
            || self
                .pinned_files
                .iter()
                .any(|(_, _, _, _, finished)| !finished)
        {
            return Err("LEAF_REJECTED");
        }
        self.validate()?;
        let (_, file, expected) = self
            .pinned_directories
            .iter()
            .find(|(name, _, _)| name == from)
            .ok_or("FILE_REJECTED")?;
        if crate::windows_identity::file_identity(file).map_err(|_| "FILE_REJECTED")? != *expected {
            return Err("FILE_REJECTED");
        }
        let parent = &self.held.last().ok_or("ROOT_REJECTED")?.handle;
        crate::windows_identity::rename_relative(file, parent, Path::new(to), false)
            .map_err(|_| "FILE_REJECTED")?;
        parent.sync_all().map_err(|_| "ROOT_REJECTED")?;
        let named = crate::windows_identity::probe_relative_directory(parent, Path::new(to))
            .map_err(|_| "FILE_REJECTED")?;
        if crate::windows_identity::file_identity(&named).map_err(|_| "FILE_REJECTED")? != *expected
        {
            return Err("FILE_REJECTED");
        }
        self.materialization_published = true;
        Ok(json!({"volumeSerial":expected.0.to_string(),"fileId":expected.1.to_string()}))
    }

    fn rollback_directory(&mut self, root_key: &str) -> Result<Value, &'static str> {
        if !valid_leaf(root_key) || self.materialization_root.as_deref() != Some(root_key) {
            return Err("LEAF_REJECTED");
        }
        if self.materialization_rolled_back {
            return Ok(json!({"settled":true}));
        }
        self.validate()?;
        while let Some((_, file, _, _, _)) = self.pinned_files.last() {
            crate::windows_identity::delete_on_close(file).map_err(|_| "FILE_REJECTED")?;
            self.pinned_files.pop();
        }
        while let Some((_, directory, _)) = self.pinned_directories.last() {
            crate::windows_identity::delete_on_close(directory).map_err(|_| "FILE_REJECTED")?;
            self.pinned_directories.pop();
        }
        self.held
            .last()
            .ok_or("ROOT_REJECTED")?
            .handle
            .sync_all()
            .map_err(|_| "ROOT_REJECTED")?;
        self.materialization_rolled_back = true;
        Ok(json!({"settled":true}))
    }

    fn prepare_atomic(
        &mut self,
        final_name: &str,
        temporary_name: &str,
        backup_name: &str,
        quarantine_name: &str,
        recovery_name: &str,
        content: &[u8],
        expected_prior: &str,
    ) -> Result<Value, &'static str> {
        if self.publication.is_some()
            || content.len() > 44 * 1024
            || (expected_prior != "any"
                && expected_prior != "absent"
                && !(expected_prior.len() == 64
                    && expected_prior
                        .bytes()
                        .all(|v| v.is_ascii_hexdigit() && !v.is_ascii_uppercase())))
            || ![
                final_name,
                temporary_name,
                backup_name,
                quarantine_name,
                recovery_name,
            ]
            .iter()
            .all(|v| valid_leaf(v))
            || final_name == temporary_name
            || final_name == backup_name
            || final_name == quarantine_name
            || temporary_name == backup_name
            || temporary_name == quarantine_name
            || backup_name == quarantine_name
            || recovery_name == final_name
            || recovery_name == temporary_name
            || recovery_name == backup_name
            || recovery_name == quarantine_name
        {
            return Err("STATE_REJECTED");
        }
        self.validate()?;
        let parent = &self.held.last().ok_or("ROOT_REJECTED")?.handle;
        let mut recovery =
            crate::windows_identity::create_relative_file(parent, Path::new(recovery_name))
                .map_err(|_| "RECOVERY_REQUIRED")?;
        append_atomic_recovery_record(
            &mut recovery,
            parent,
            &AtomicRecoveryRecord {
                version: 1,
                final_name: final_name.to_string(),
                temporary_name: temporary_name.to_string(),
                backup_name: backup_name.to_string(),
                quarantine_name: quarantine_name.to_string(),
                recovery_name: recovery_name.to_string(),
                expected_prior: expected_prior.to_string(),
                temporary_volume_serial: None,
                temporary_file_id: None,
                prior_volume_serial: None,
                prior_file_id: None,
                backup_volume_serial: None,
                backup_file_id: None,
                stage: "intent".to_string(),
            },
        )?;
        let temporary =
            crate::windows_identity::create_relative_file(parent, Path::new(temporary_name))
                .map_err(|_| "FILE_REJECTED")?;
        let metadata = temporary.metadata().map_err(|_| "FILE_REJECTED")?;
        let temporary_identity =
            crate::windows_identity::file_identity(&temporary).map_err(|_| "FILE_REJECTED")?;
        self.publication = Some(AtomicPublication {
            final_name: final_name.to_string(),
            temporary_name: temporary_name.to_string(),
            backup_name: backup_name.to_string(),
            quarantine_name: quarantine_name.to_string(),
            temporary: Some(temporary),
            temporary_identity,
            prior: None,
            prior_identity: None,
            stage: AtomicPublicationStage::Preparing,
            backup_created: false,
            recovery_name: recovery_name.to_string(),
            expected_prior: expected_prior.to_string(),
            recovery: Some(recovery),
        });
        // Exact temporary identity is appended before content I/O. The prior
        // intent record remains a durable fallback if creation was interrupted.
        self.mark_recovery_required()?;
        let publication = self.publication.as_mut().ok_or("STATE_REJECTED")?;
        let temporary = publication.temporary.as_mut().ok_or("FILE_REJECTED")?;
        temporary.write_all(content).map_err(|_| "FILE_REJECTED")?;
        temporary.sync_all().map_err(|_| "FILE_REJECTED")?;
        let metadata = temporary.metadata().map_err(|_| "FILE_REJECTED")?;
        if !metadata.is_file()
            || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || metadata.file_size() != content.len() as u64
        {
            return Err("FILE_REJECTED");
        }
        temporary.rewind().map_err(|_| "FILE_REJECTED")?;
        let mut observed = Vec::with_capacity(content.len() + 1);
        Read::by_ref(&mut temporary)
            .take(content.len() as u64 + 1)
            .read_to_end(&mut observed)
            .map_err(|_| "FILE_REJECTED")?;
        if observed != content {
            return Err("FILE_REJECTED");
        }
        if crate::windows_identity::file_identity(temporary).map_err(|_| "FILE_REJECTED")?
            != temporary_identity
        {
            return Err("FILE_REJECTED");
        }
        self.publication.as_mut().ok_or("STATE_REJECTED")?.stage =
            AtomicPublicationStage::Temporary;
        self.write_recovery_record()?;
        let parent = &self.held.last().ok_or("ROOT_REJECTED")?.handle;
        let prior =
            crate::windows_identity::open_relative_file_optional(parent, Path::new(final_name))
                .map_err(|_| "FILE_REJECTED")?;
        let prior_identity = if let Some(file) = prior.as_ref() {
            let metadata = file.metadata().map_err(|_| "FILE_REJECTED")?;
            if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            {
                return Err("FILE_REJECTED");
            }
            let identity =
                crate::windows_identity::file_identity(file).map_err(|_| "FILE_REJECTED")?;
            Some(identity)
        } else {
            None
        };
        if (expected_prior == "absent" && prior.is_some())
            || (expected_prior != "any" && expected_prior != "absent" && prior.is_none())
        {
            return Err("CAS_REJECTED");
        }
        if expected_prior != "any" && expected_prior != "absent" {
            let file = prior.as_ref().ok_or("CAS_REJECTED")?;
            let mut reader = file.try_clone().map_err(|_| "FILE_REJECTED")?;
            let mut bytes = Vec::new();
            Read::by_ref(&mut reader)
                .take(1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "FILE_REJECTED")?;
            if bytes.len() > 1024 * 1024 || crate::sha256_hex(&bytes) != expected_prior {
                return Err("CAS_REJECTED");
            }
        }
        {
            let publication = self.publication.as_mut().ok_or("STATE_REJECTED")?;
            publication.prior = prior;
            publication.prior_identity = prior_identity;
            publication.stage = AtomicPublicationStage::PriorCaptured;
        }
        self.write_recovery_record()?;
        if prior_identity.is_some() {
            let publication = self.publication.as_ref().ok_or("STATE_REJECTED")?;
            crate::windows_identity::link_relative(
                publication.prior.as_ref().ok_or("FILE_REJECTED")?,
                parent,
                Path::new(backup_name),
            )
            .map_err(|_| "FILE_REJECTED")?;
            self.publication
                .as_mut()
                .ok_or("STATE_REJECTED")?
                .backup_created = true;
            parent.sync_all().map_err(|_| "ROOT_REJECTED")?;
        }
        self.write_recovery_record()?;
        let parent = &self.held.last().ok_or("ROOT_REJECTED")?.handle;
        let retained = self.publication.as_ref().ok_or("STATE_REJECTED")?;
        crate::windows_identity::rename_relative(
            retained.temporary.as_ref().ok_or("FILE_REJECTED")?,
            parent,
            Path::new(final_name),
            prior_identity.is_some(),
        )
        .map_err(|_| "FILE_REJECTED")?;
        self.publication.as_mut().ok_or("STATE_REJECTED")?.stage =
            AtomicPublicationStage::Published;
        parent.sync_all().map_err(|_| "ROOT_REJECTED")?;
        self.write_recovery_record()?;
        let parent = &self.held.last().ok_or("ROOT_REJECTED")?.handle;
        let named = crate::windows_identity::probe_relative_file(parent, Path::new(final_name))
            .map_err(|_| "FILE_REJECTED")?;
        if crate::windows_identity::file_identity(&named).map_err(|_| "FILE_REJECTED")?
            != temporary_identity
        {
            return Err("FILE_REJECTED");
        }
        Ok(
            json!({"volumeSerial":temporary_identity.0.to_string(),"fileId":temporary_identity.1.to_string(),"size":content.len().to_string()}),
        )
    }

    fn write_recovery_record(&mut self) -> Result<(), &'static str> {
        self.validate()?;
        let parent = &self.held.last().ok_or("ROOT_REJECTED")?.handle;
        let Some(publication) = self.publication.as_mut() else {
            return Err("STATE_REJECTED");
        };
        let prior = publication.prior_identity;
        let record = AtomicRecoveryRecord {
            version: 1,
            final_name: publication.final_name.clone(),
            temporary_name: publication.temporary_name.clone(),
            backup_name: publication.backup_name.clone(),
            quarantine_name: publication.quarantine_name.clone(),
            recovery_name: publication.recovery_name.clone(),
            expected_prior: publication.expected_prior.clone(),
            temporary_volume_serial: Some(publication.temporary_identity.0.to_string()),
            temporary_file_id: Some(publication.temporary_identity.1.to_string()),
            prior_volume_serial: prior.map(|identity| identity.0.to_string()),
            prior_file_id: prior.map(|identity| identity.1.to_string()),
            backup_volume_serial: prior
                .filter(|_| publication.backup_created)
                .map(|identity| identity.0.to_string()),
            backup_file_id: prior
                .filter(|_| publication.backup_created)
                .map(|identity| identity.1.to_string()),
            stage: match publication.stage {
                AtomicPublicationStage::Preparing => "preparing",
                AtomicPublicationStage::Temporary => "temporary",
                AtomicPublicationStage::PriorCaptured => "prior_captured",
                AtomicPublicationStage::Published => "published",
            }
            .to_string(),
        };
        let recovery = publication.recovery.as_mut().ok_or("RECOVERY_REQUIRED")?;
        append_atomic_recovery_record(recovery, parent, &record)
    }

    fn mark_recovery_required(&mut self) -> Result<Value, &'static str> {
        if self.publication.is_none() {
            return Ok(json!({"marked":false}));
        }
        self.write_recovery_record()?;
        Ok(json!({"marked":true}))
    }

    fn clear_recovery_required(
        publication: &mut AtomicPublication,
        parent: &std::fs::File,
    ) -> Result<(), &'static str> {
        if let Some(recovery) = publication.recovery.as_ref() {
            crate::windows_identity::delete_on_close(recovery).map_err(|_| "RECOVERY_REQUIRED")?;
        }
        if let Some(recovery) = publication.recovery.take() {
            drop(recovery);
            parent.sync_all().map_err(|_| "RECOVERY_REQUIRED")?;
        }
        Ok(())
    }

    fn recover_atomic(
        &mut self,
        recovery_name: &str,
        decision: &str,
    ) -> Result<Value, &'static str> {
        if self.publication.is_some()
            || !valid_leaf(recovery_name)
            || !matches!(decision, "commit" | "rollback")
        {
            return Err("STATE_REJECTED");
        }
        self.validate()?;
        let parent = &self.held.last().ok_or("ROOT_REJECTED")?.handle;
        let Some(mut recovery) =
            crate::windows_identity::open_relative_file_optional(parent, Path::new(recovery_name))
                .map_err(|_| "RECOVERY_REQUIRED")?
        else {
            return Ok(json!({"recovered":false}));
        };
        let mut bytes = Vec::new();
        Read::by_ref(&mut recovery)
            .take(MAX_WIRE as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "RECOVERY_REQUIRED")?;
        if bytes.len() > MAX_WIRE {
            return Err("RECOVERY_REQUIRED");
        }
        if bytes.is_empty() || bytes == b"opencode-windows-atomic-recovery-required-v1\n" {
            if decision != "rollback" {
                return Err("RECOVERY_REQUIRED");
            }
            crate::windows_identity::delete_on_close(&recovery).map_err(|_| "RECOVERY_REQUIRED")?;
            drop(recovery);
            parent.sync_all().map_err(|_| "RECOVERY_REQUIRED")?;
            return Ok(json!({"recovered":true}));
        }
        let Some(complete_length) = bytes.iter().rposition(|value| *value == b'\n') else {
            // Temporary creation is ordered after the first newline-terminated,
            // synced intent record. A torn first record therefore has no
            // transaction-owned namespace object and is safe to clear only as
            // an explicit rollback decision.
            if decision != "rollback" {
                return Err("RECOVERY_REQUIRED");
            }
            crate::windows_identity::delete_on_close(&recovery).map_err(|_| "RECOVERY_REQUIRED")?;
            drop(recovery);
            parent.sync_all().map_err(|_| "RECOVERY_REQUIRED")?;
            return Ok(json!({"recovered":true}));
        };
        let mut records = Vec::new();
        for line in bytes[..complete_length].split(|value| *value == b'\n') {
            if line.is_empty() {
                return Err("RECOVERY_REQUIRED");
            }
            records.push(
                serde_json::from_slice::<AtomicRecoveryRecord>(line)
                    .map_err(|_| "RECOVERY_REQUIRED")?,
            );
        }
        let stage_rank = |stage: &str| match stage {
            "intent" => Some(0),
            "preparing" => Some(1),
            "temporary" => Some(2),
            "prior_captured" => Some(3),
            "published" => Some(4),
            _ => None,
        };
        for entry in &records {
            let temporary_paired =
                entry.temporary_volume_serial.is_some() == entry.temporary_file_id.is_some();
            let prior_paired = entry.prior_volume_serial.is_some() == entry.prior_file_id.is_some();
            let backup_paired =
                entry.backup_volume_serial.is_some() == entry.backup_file_id.is_some();
            if stage_rank(&entry.stage).is_none()
                || !temporary_paired
                || !prior_paired
                || !backup_paired
                || (entry.stage == "intent"
                    && (entry.temporary_volume_serial.is_some()
                        || entry.prior_volume_serial.is_some()
                        || entry.backup_volume_serial.is_some()))
                || (entry.stage != "intent" && entry.temporary_volume_serial.is_none())
                || (matches!(entry.stage.as_str(), "preparing" | "temporary")
                    && (entry.prior_volume_serial.is_some()
                        || entry.backup_volume_serial.is_some()))
                || (entry.backup_volume_serial.is_some()
                    && (entry.backup_volume_serial != entry.prior_volume_serial
                        || entry.backup_file_id != entry.prior_file_id))
            {
                return Err("RECOVERY_REQUIRED");
            }
        }
        for pair in records.windows(2) {
            let prior = &pair[0];
            let next = &pair[1];
            if prior.version != next.version
                || prior.final_name != next.final_name
                || prior.temporary_name != next.temporary_name
                || prior.backup_name != next.backup_name
                || prior.quarantine_name != next.quarantine_name
                || prior.recovery_name != next.recovery_name
                || prior.expected_prior != next.expected_prior
                || stage_rank(&prior.stage).ok_or("RECOVERY_REQUIRED")?
                    > stage_rank(&next.stage).ok_or("RECOVERY_REQUIRED")?
                || (prior.temporary_volume_serial.is_some()
                    && (prior.temporary_volume_serial != next.temporary_volume_serial
                        || prior.temporary_file_id != next.temporary_file_id))
                || (prior.prior_volume_serial.is_some()
                    && (prior.prior_volume_serial != next.prior_volume_serial
                        || prior.prior_file_id != next.prior_file_id))
                || (prior.backup_volume_serial.is_some()
                    && (prior.backup_volume_serial != next.backup_volume_serial
                        || prior.backup_file_id != next.backup_file_id))
            {
                return Err("RECOVERY_REQUIRED");
            }
        }
        let record = records.pop().ok_or("RECOVERY_REQUIRED")?;
        if record.version != 1
            || record.recovery_name != recovery_name
            || (record.expected_prior != "any"
                && record.expected_prior != "absent"
                && !(record.expected_prior.len() == 64
                    && record
                        .expected_prior
                        .bytes()
                        .all(|value| value.is_ascii_hexdigit() && !value.is_ascii_uppercase())))
            || !matches!(
                record.stage.as_str(),
                "intent" | "preparing" | "temporary" | "prior_captured" | "published"
            )
            || ![
                &record.final_name,
                &record.temporary_name,
                &record.backup_name,
                &record.quarantine_name,
                &record.recovery_name,
            ]
            .iter()
            .all(|name| valid_leaf(name))
            || {
                let names = [
                    record.final_name.as_str(),
                    record.temporary_name.as_str(),
                    record.backup_name.as_str(),
                    record.quarantine_name.as_str(),
                    record.recovery_name.as_str(),
                ];
                names
                    .iter()
                    .enumerate()
                    .any(|(index, name)| names[index + 1..].contains(name))
            }
        {
            return Err("RECOVERY_REQUIRED");
        }
        if record.stage == "intent" {
            if decision != "rollback"
                || record.temporary_volume_serial.is_some()
                || record.temporary_file_id.is_some()
                || record.prior_volume_serial.is_some()
                || record.prior_file_id.is_some()
                || record.backup_volume_serial.is_some()
                || record.backup_file_id.is_some()
            {
                return Err("RECOVERY_REQUIRED");
            }
            crate::windows_identity::delete_on_close(&recovery).map_err(|_| "RECOVERY_REQUIRED")?;
            drop(recovery);
            parent.sync_all().map_err(|_| "RECOVERY_REQUIRED")?;
            return Ok(json!({"recovered":true}));
        }
        let temporary_identity = match (&record.temporary_volume_serial, &record.temporary_file_id)
        {
            (Some(volume), Some(file)) => (
                volume.parse::<u64>().map_err(|_| "RECOVERY_REQUIRED")?,
                file.parse::<u128>().map_err(|_| "RECOVERY_REQUIRED")?,
            ),
            _ => return Err("RECOVERY_REQUIRED"),
        };
        let prior_identity = match (&record.prior_volume_serial, &record.prior_file_id) {
            (None, None) => None,
            (Some(volume), Some(file)) => Some((
                volume.parse::<u64>().map_err(|_| "RECOVERY_REQUIRED")?,
                file.parse::<u128>().map_err(|_| "RECOVERY_REQUIRED")?,
            )),
            _ => return Err("RECOVERY_REQUIRED"),
        };
        let backup_identity = match (&record.backup_volume_serial, &record.backup_file_id) {
            (None, None) => None,
            (Some(volume), Some(file)) => Some((
                volume.parse::<u64>().map_err(|_| "RECOVERY_REQUIRED")?,
                file.parse::<u128>().map_err(|_| "RECOVERY_REQUIRED")?,
            )),
            _ => return Err("RECOVERY_REQUIRED"),
        };
        if matches!(record.stage.as_str(), "preparing" | "temporary")
            && (prior_identity.is_some() || backup_identity.is_some())
        {
            return Err("RECOVERY_REQUIRED");
        }
        let root_volume = self.held.last().ok_or("ROOT_REJECTED")?.identity.0;
        if temporary_identity.0 != root_volume
            || prior_identity.is_some_and(|identity| identity.0 != root_volume)
            || backup_identity.is_some_and(|identity| identity.0 != root_volume)
            || backup_identity.is_some_and(|identity| Some(identity) != prior_identity)
        {
            return Err("RECOVERY_REQUIRED");
        }
        let identity_at =
            |name: &str| -> Result<Option<crate::windows_identity::FileIdentity>, &'static str> {
                crate::windows_identity::probe_relative_file_optional(parent, Path::new(name))
                    .map_err(|_| "RECOVERY_REQUIRED")?
                    .as_ref()
                    .map(crate::windows_identity::file_identity)
                    .transpose()
                    .map_err(|_| "RECOVERY_REQUIRED")
            };
        let mut final_identity = identity_at(&record.final_name)?;
        if decision == "commit" {
            if record.stage == "preparing" {
                return Err("RECOVERY_REQUIRED");
            }
            if final_identity != Some(temporary_identity) {
                if final_identity != prior_identity {
                    return Err("SUCCESSOR_PRESENT");
                }
                let temporary = crate::windows_identity::open_relative_file(
                    parent,
                    Path::new(&record.temporary_name),
                )
                .map_err(|_| "RECOVERY_REQUIRED")?;
                if crate::windows_identity::file_identity(&temporary)
                    .map_err(|_| "RECOVERY_REQUIRED")?
                    != temporary_identity
                {
                    return Err("SUCCESSOR_PRESENT");
                }
                if let Some(expected) = prior_identity {
                    match identity_at(&record.backup_name)? {
                        Some(identity) if identity == expected => {}
                        Some(_) => return Err("SUCCESSOR_PRESENT"),
                        None => {
                            let prior = crate::windows_identity::open_relative_file(
                                parent,
                                Path::new(&record.final_name),
                            )
                            .map_err(|_| "RECOVERY_REQUIRED")?;
                            if crate::windows_identity::file_identity(&prior)
                                .map_err(|_| "RECOVERY_REQUIRED")?
                                != expected
                            {
                                return Err("SUCCESSOR_PRESENT");
                            }
                            crate::windows_identity::link_relative(
                                &prior,
                                parent,
                                Path::new(&record.backup_name),
                            )
                            .map_err(|_| "RECOVERY_REQUIRED")?;
                            parent.sync_all().map_err(|_| "RECOVERY_REQUIRED")?;
                        }
                    }
                }
                crate::windows_identity::rename_relative(
                    &temporary,
                    parent,
                    Path::new(&record.final_name),
                    final_identity.is_some(),
                )
                .map_err(|_| "RECOVERY_REQUIRED")?;
                parent.sync_all().map_err(|_| "RECOVERY_REQUIRED")?;
                final_identity = identity_at(&record.final_name)?;
            }
            if final_identity != Some(temporary_identity) {
                return Err("RECOVERY_REQUIRED");
            }
        } else if !matches!(record.stage.as_str(), "preparing" | "temporary") {
            if final_identity == Some(temporary_identity) {
                let published = crate::windows_identity::open_relative_file(
                    parent,
                    Path::new(&record.final_name),
                )
                .map_err(|_| "RECOVERY_REQUIRED")?;
                if identity_at(&record.quarantine_name)? == Some(temporary_identity) {
                    let old = crate::windows_identity::open_relative_file(
                        parent,
                        Path::new(&record.quarantine_name),
                    )
                    .map_err(|_| "RECOVERY_REQUIRED")?;
                    crate::windows_identity::delete_on_close(&old)
                        .map_err(|_| "RECOVERY_REQUIRED")?;
                    drop(old);
                }
                crate::windows_identity::rename_relative(
                    &published,
                    parent,
                    Path::new(&record.quarantine_name),
                    false,
                )
                .map_err(|_| "RECOVERY_REQUIRED")?;
                parent.sync_all().map_err(|_| "RECOVERY_REQUIRED")?;
                final_identity = identity_at(&record.final_name)?;
            }
            if final_identity != prior_identity {
                if final_identity.is_some() {
                    return Err("SUCCESSOR_PRESENT");
                }
                if let Some(expected) = prior_identity {
                    let backup = crate::windows_identity::open_relative_file(
                        parent,
                        Path::new(&record.backup_name),
                    )
                    .map_err(|_| "RECOVERY_REQUIRED")?;
                    if crate::windows_identity::file_identity(&backup)
                        .map_err(|_| "RECOVERY_REQUIRED")?
                        != expected
                    {
                        return Err("SUCCESSOR_PRESENT");
                    }
                    crate::windows_identity::link_relative(
                        &backup,
                        parent,
                        Path::new(&record.final_name),
                    )
                    .map_err(|_| "RECOVERY_REQUIRED")?;
                    parent.sync_all().map_err(|_| "RECOVERY_REQUIRED")?;
                }
            }
            if identity_at(&record.final_name)? != prior_identity {
                return Err("RECOVERY_REQUIRED");
            }
        }
        for (name, expected) in [
            (&record.temporary_name, temporary_identity),
            (&record.quarantine_name, temporary_identity),
        ] {
            if identity_at(name)? == Some(expected) {
                let file = crate::windows_identity::open_relative_file(parent, Path::new(name))
                    .map_err(|_| "RECOVERY_REQUIRED")?;
                crate::windows_identity::delete_on_close(&file).map_err(|_| "RECOVERY_REQUIRED")?;
                drop(file);
            }
        }
        if let Some(expected) = prior_identity {
            if identity_at(&record.backup_name)? == Some(expected) {
                let backup = crate::windows_identity::open_relative_file(
                    parent,
                    Path::new(&record.backup_name),
                )
                .map_err(|_| "RECOVERY_REQUIRED")?;
                crate::windows_identity::delete_on_close(&backup)
                    .map_err(|_| "RECOVERY_REQUIRED")?;
                drop(backup);
            }
        }
        crate::windows_identity::delete_on_close(&recovery).map_err(|_| "RECOVERY_REQUIRED")?;
        drop(recovery);
        parent.sync_all().map_err(|_| "RECOVERY_REQUIRED")?;
        Ok(json!({"recovered":true}))
    }

    fn settle_atomic(&mut self, rollback: bool) -> Result<Value, &'static str> {
        self.validate()?;
        let parent = &self.held.last().ok_or("ROOT_REJECTED")?.handle;
        let publication = self.publication.as_mut().ok_or("STATE_REJECTED")?;
        if !rollback {
            if publication.stage != AtomicPublicationStage::Published {
                return Err("STATE_REJECTED");
            }
            // Durability is the commit boundary. Attempt-owned backup cleanup
            // follows but can only leave conservative garbage; it can never
            // revoke an already-durable new final or trigger rollback after
            // the prior link has been removed.
            parent.sync_all().map_err(|_| "ROOT_REJECTED")?;
            drop(publication.prior.take());
            if publication.backup_created {
                if let Ok(Some(backup)) = crate::windows_identity::open_relative_file_optional(
                    parent,
                    Path::new(&publication.backup_name),
                ) {
                    if crate::windows_identity::file_identity(&backup).ok()
                        == publication.prior_identity
                        && crate::windows_identity::delete_on_close(&backup).is_ok()
                    {
                        drop(backup);
                        let _ = parent.sync_all();
                    }
                }
            }
            Self::clear_recovery_required(publication, parent)?;
            self.publication = None;
            return Ok(json!({"settled":true}));
        } else if publication.stage != AtomicPublicationStage::Published {
            // Visibility never changed. Never inspect, rename, or unlink the
            // final pathname in this state: it may be a racing successor.
            if let Some(temporary) = publication.temporary.take() {
                crate::windows_identity::delete_on_close(&temporary)
                    .map_err(|_| "FILE_REJECTED")?;
                drop(temporary);
                parent.sync_all().map_err(|_| "ROOT_REJECTED")?;
            }
            // A captured prior remains authoritative until all fallible work
            // is complete. Its attempt-owned hard-link backup may remain as
            // conservative evidence; no pathname cleanup justifies releasing
            // that authority early.
            Self::clear_recovery_required(publication, parent)?;
            parent.sync_all().map_err(|_| "ROOT_REJECTED")?;
            self.publication = None;
            return Ok(json!({"settled":true}));
        } else {
            let named = crate::windows_identity::probe_relative_file_optional(
                parent,
                Path::new(&publication.final_name),
            )
            .map_err(|_| "FILE_REJECTED")?;
            let named_identity = named
                .as_ref()
                .map(crate::windows_identity::file_identity)
                .transpose()
                .map_err(|_| "FILE_REJECTED")?;
            if named_identity == Some(publication.temporary_identity) {
                crate::windows_identity::rename_relative(
                    publication.temporary.as_ref().ok_or("FILE_REJECTED")?,
                    parent,
                    Path::new(&publication.quarantine_name),
                    false,
                )
                .map_err(|_| "FILE_REJECTED")?;
                parent.sync_all().map_err(|_| "ROOT_REJECTED")?;
            } else if named_identity != publication.prior_identity && named_identity.is_some() {
                return Err("SUCCESSOR_PRESENT");
            }
            let after = crate::windows_identity::probe_relative_file_optional(
                parent,
                Path::new(&publication.final_name),
            )
            .map_err(|_| "FILE_REJECTED")?;
            if after.is_none() {
                if let Some(prior) = publication.prior.as_ref() {
                    crate::windows_identity::link_relative(
                        prior,
                        parent,
                        Path::new(&publication.final_name),
                    )
                    .map_err(|_| "FILE_REJECTED")?;
                    parent.sync_all().map_err(|_| "ROOT_REJECTED")?;
                }
            }
            let restored = crate::windows_identity::probe_relative_file_optional(
                parent,
                Path::new(&publication.final_name),
            )
            .map_err(|_| "FILE_REJECTED")?;
            let restored_identity = restored
                .as_ref()
                .map(crate::windows_identity::file_identity)
                .transpose()
                .map_err(|_| "FILE_REJECTED")?;
            if restored_identity != publication.prior_identity {
                return Err("FILE_REJECTED");
            }
            if let Some(temporary) = publication.temporary.take() {
                crate::windows_identity::delete_on_close(&temporary)
                    .map_err(|_| "FILE_REJECTED")?;
                drop(temporary);
                parent.sync_all().map_err(|_| "ROOT_REJECTED")?;
            }
        }
        // Keep the prior handle (and therefore every hard link to that exact
        // object) pinned through the last fallible recovery barrier. Backup
        // removal after releasing it would create a successor-unlink race, so
        // rollback deliberately leaves that attempt-owned link as evidence.
        parent.sync_all().map_err(|_| "ROOT_REJECTED")?;
        Self::clear_recovery_required(publication, parent)?;
        self.publication = None;
        Ok(json!({"settled":true}))
    }
}

fn valid_leaf(name: &str) -> bool {
    name.len() <= 255 && valid_component(name)
}

fn valid_materialization_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 4096 && key.split('/').all(valid_component)
}

#[cfg(test)]
mod path_tests {
    use super::{decode_bounded_base64, valid_leaf, valid_materialization_key, valid_root_input};

    #[test]
    fn rejects_win32_alias_and_namespace_syntax() {
        for path in [
            r"C:\safe:stream",
            r"\\?\C:\safe",
            r"\\.\C:\safe",
            r"C:\safe\..\escape",
            r"C:\safe\.\child",
            r"C:\CON\child",
            r"C:\safe\NUL.txt",
            r"C:\safe\\child",
        ] {
            assert!(!valid_root_input(path), "accepted {path}");
        }
        assert!(valid_root_input(r"C:\safe\child"));
        for leaf in ["auth.json:stream", "CON", "nul.txt", "COM1.log", ".."] {
            assert!(!valid_leaf(leaf), "accepted {leaf}");
        }
    }

    #[test]
    fn atomic_bytes_require_canonical_bounded_base64() {
        assert_eq!(decode_bounded_base64("AQID").unwrap(), [1, 2, 3]);
        for invalid in ["A", "====", "AB==", "AQI=AAAA", "credential!"] {
            assert!(decode_bounded_base64(invalid).is_err());
        }
    }

    #[test]
    fn materialization_keys_are_component_bounded() {
        assert!(valid_materialization_key("attempt/config/opencode.json"));
        for invalid in [
            "",
            "attempt//file",
            "attempt/../file",
            "attempt/NUL",
            "attempt\\file",
        ] {
            assert!(!valid_materialization_key(invalid));
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "op", deny_unknown_fields)]
enum Request {
    OPEN_ROOT {
        version: u8,
        id: String,
        wait_ms: u32,
        root_path: String,
        create_missing: bool,
        durable_ancestors: bool,
    },
    VALIDATE_ROOT {
        version: u8,
        id: String,
        wait_ms: u32,
    },
    PIN_REGULAR {
        version: u8,
        id: String,
        wait_ms: u32,
        parent_key: String,
        name: String,
    },
    PIN_REGULAR_READONLY {
        version: u8,
        id: String,
        wait_ms: u32,
        parent_key: String,
        name: String,
    },
    OPEN_CHILD_DIRECTORY {
        version: u8,
        id: String,
        wait_ms: u32,
        parent_key: String,
        key: String,
        name: String,
    },
    CREATE_DIRECTORY {
        version: u8,
        id: String,
        wait_ms: u32,
        name: String,
    },
    CREATE_CHILD_DIRECTORY {
        version: u8,
        id: String,
        wait_ms: u32,
        parent_key: String,
        key: String,
        name: String,
    },
    CREATE_CHILD_FILE {
        version: u8,
        id: String,
        wait_ms: u32,
        parent_key: String,
        key: String,
        name: String,
    },
    WRITE_CHILD_FILE {
        version: u8,
        id: String,
        wait_ms: u32,
        key: String,
        offset: u64,
        content_base64: String,
        finish: bool,
    },
    RENAME_DIRECTORY {
        version: u8,
        id: String,
        wait_ms: u32,
        from: String,
        to: String,
    },
    ROLLBACK_DIRECTORY {
        version: u8,
        id: String,
        wait_ms: u32,
        root_key: String,
    },
    PREPARE_ATOMIC {
        version: u8,
        id: String,
        wait_ms: u32,
        final_name: String,
        temporary_name: String,
        backup_name: String,
        quarantine_name: String,
        recovery_name: String,
        expected_prior: String,
        content_base64: String,
    },
    MARK_RECOVERY_REQUIRED {
        version: u8,
        id: String,
        wait_ms: u32,
    },
    COMMIT_ATOMIC {
        version: u8,
        id: String,
        wait_ms: u32,
    },
    ROLLBACK_ATOMIC {
        version: u8,
        id: String,
        wait_ms: u32,
    },
    RECOVER_ATOMIC {
        version: u8,
        id: String,
        wait_ms: u32,
        recovery_name: String,
        decision: String,
    },
    NS_STAT {
        version: u8,
        id: String,
        wait_ms: u32,
        path: String,
    },
    NS_MKDIR {
        version: u8,
        id: String,
        wait_ms: u32,
        path: String,
    },
    NS_OPEN {
        version: u8,
        id: String,
        wait_ms: u32,
        path: String,
        token: String,
        mode: String,
    },
    NS_READ {
        version: u8,
        id: String,
        wait_ms: u32,
        token: String,
        offset: u64,
        length: usize,
    },
    NS_WRITE {
        version: u8,
        id: String,
        wait_ms: u32,
        token: String,
        offset: u64,
        truncate: bool,
        content_base64: String,
    },
    NS_SYNC_HANDLE {
        version: u8,
        id: String,
        wait_ms: u32,
        token: String,
    },
    NS_CLOSE_HANDLE {
        version: u8,
        id: String,
        wait_ms: u32,
        token: String,
    },
    NS_RENAME {
        version: u8,
        id: String,
        wait_ms: u32,
        from: String,
        to: String,
    },
    NS_UNLINK {
        version: u8,
        id: String,
        wait_ms: u32,
        path: String,
        directory: bool,
    },
    NS_SYNC_DIRECTORY {
        version: u8,
        id: String,
        wait_ms: u32,
        path: String,
    },
    SYNC_ROOT {
        version: u8,
        id: String,
        wait_ms: u32,
    },
    CLOSE {
        version: u8,
        id: String,
        wait_ms: u32,
    },
}

impl Request {
    fn common(&self) -> (u8, &str, u32) {
        match self {
            Self::OPEN_ROOT {
                version,
                id,
                wait_ms,
                ..
            }
            | Self::VALIDATE_ROOT {
                version,
                id,
                wait_ms,
            }
            | Self::PIN_REGULAR {
                version,
                id,
                wait_ms,
                ..
            }
            | Self::PIN_REGULAR_READONLY {
                version,
                id,
                wait_ms,
                ..
            }
            | Self::OPEN_CHILD_DIRECTORY {
                version,
                id,
                wait_ms,
                ..
            }
            | Self::CREATE_DIRECTORY {
                version,
                id,
                wait_ms,
                ..
            }
            | Self::CREATE_CHILD_DIRECTORY {
                version,
                id,
                wait_ms,
                ..
            }
            | Self::CREATE_CHILD_FILE {
                version,
                id,
                wait_ms,
                ..
            }
            | Self::WRITE_CHILD_FILE {
                version,
                id,
                wait_ms,
                ..
            }
            | Self::RENAME_DIRECTORY {
                version,
                id,
                wait_ms,
                ..
            }
            | Self::ROLLBACK_DIRECTORY {
                version,
                id,
                wait_ms,
                ..
            }
            | Self::PREPARE_ATOMIC {
                version,
                id,
                wait_ms,
                ..
            }
            | Self::MARK_RECOVERY_REQUIRED {
                version,
                id,
                wait_ms,
            }
            | Self::COMMIT_ATOMIC {
                version,
                id,
                wait_ms,
            }
            | Self::ROLLBACK_ATOMIC {
                version,
                id,
                wait_ms,
            }
            | Self::RECOVER_ATOMIC {
                version,
                id,
                wait_ms,
                ..
            }
            | Self::SYNC_ROOT {
                version,
                id,
                wait_ms,
            }
            | Self::NS_STAT {
                version,
                id,
                wait_ms,
                ..
            }
            | Self::NS_MKDIR {
                version,
                id,
                wait_ms,
                ..
            }
            | Self::NS_OPEN {
                version,
                id,
                wait_ms,
                ..
            }
            | Self::NS_READ {
                version,
                id,
                wait_ms,
                ..
            }
            | Self::NS_WRITE {
                version,
                id,
                wait_ms,
                ..
            }
            | Self::NS_SYNC_HANDLE {
                version,
                id,
                wait_ms,
                ..
            }
            | Self::NS_CLOSE_HANDLE {
                version,
                id,
                wait_ms,
                ..
            }
            | Self::NS_RENAME {
                version,
                id,
                wait_ms,
                ..
            }
            | Self::NS_UNLINK {
                version,
                id,
                wait_ms,
                ..
            }
            | Self::NS_SYNC_DIRECTORY {
                version,
                id,
                wait_ms,
                ..
            }
            | Self::CLOSE {
                version,
                id,
                wait_ms,
            } => (*version, id, *wait_ms),
        }
    }
}

pub fn run() {
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let mut out = io::BufWriter::new(io::stdout().lock());
    let mut root: Option<RetainedWindowsRoot> = None;
    loop {
        let line = match crate::read_bounded_line(&mut input, MAX_WIRE) {
            Ok(Some(v)) => v,
            _ => break,
        };
        let request: Request = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => break,
        };
        let (version, id, wait_ms) = request.common();
        if version != 1 || !valid_id(id) || wait_ms == 0 {
            break;
        }
        let deadline = Instant::now() + Duration::from_millis(wait_ms as u64);
        // Synchronous NTFS calls are deliberately used to retain exact object
        // authority. A per-command process watchdog is their cancellation
        // boundary: deadline expiry closes every retained handle even if the
        // worker thread is blocked inside a filesystem call.
        let (deadline_cancel, deadline_wait) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            if matches!(
                deadline_wait.recv_timeout(deadline.saturating_duration_since(Instant::now())),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            ) {
                std::process::exit(124);
            }
        });
        let (result, close): (Result<Value, &'static str>, bool) = match request {
            Request::OPEN_ROOT {
                root_path,
                create_missing,
                durable_ancestors,
                ..
            } if root.is_none() => {
                match RetainedWindowsRoot::open(
                    PathBuf::from(root_path),
                    create_missing,
                    durable_ancestors,
                ) {
                    Ok((opened, created)) => {
                        let identity = opened.held.last().unwrap().identity;
                        root = Some(opened);
                        (
                            Ok(
                                json!({"volumeSerial":identity.0.to_string(),"fileId":identity.1.to_string(),"createdPaths":created}),
                            ),
                            false,
                        )
                    }
                    Err(code) => (Err(code), false),
                }
            }
            Request::VALIDATE_ROOT { .. } => (
                root.as_ref()
                    .ok_or("ROOT_REQUIRED")
                    .and_then(|v| v.validate())
                    .map(|_| json!({})),
                false,
            ),
            Request::PIN_REGULAR {
                parent_key, name, ..
            } => (
                root.as_mut()
                    .ok_or("ROOT_REQUIRED")
                    .and_then(|v| v.pin(&parent_key, &name, false)),
                false,
            ),
            Request::PIN_REGULAR_READONLY {
                parent_key, name, ..
            } => (
                root.as_mut()
                    .ok_or("ROOT_REQUIRED")
                    .and_then(|v| v.pin(&parent_key, &name, true)),
                false,
            ),
            Request::OPEN_CHILD_DIRECTORY {
                parent_key,
                key,
                name,
                ..
            } => (
                root.as_mut()
                    .ok_or("ROOT_REQUIRED")
                    .and_then(|v| v.open_child_directory(&parent_key, &key, &name)),
                false,
            ),
            Request::CREATE_DIRECTORY { name, .. } => (
                root.as_mut()
                    .ok_or("ROOT_REQUIRED")
                    .and_then(|v| v.create_directory(&name)),
                false,
            ),
            Request::CREATE_CHILD_DIRECTORY {
                parent_key,
                key,
                name,
                ..
            } => (
                root.as_mut()
                    .ok_or("ROOT_REQUIRED")
                    .and_then(|v| v.create_child_directory(&parent_key, &key, &name)),
                false,
            ),
            Request::CREATE_CHILD_FILE {
                parent_key,
                key,
                name,
                ..
            } => (
                root.as_mut()
                    .ok_or("ROOT_REQUIRED")
                    .and_then(|v| v.create_child_file(&parent_key, &key, &name)),
                false,
            ),
            Request::WRITE_CHILD_FILE {
                key,
                offset,
                content_base64,
                finish,
                ..
            } => (
                decode_bounded_base64(&content_base64).and_then(|content| {
                    root.as_mut()
                        .ok_or("ROOT_REQUIRED")
                        .and_then(|v| v.write_child_file(&key, offset, &content, finish))
                }),
                false,
            ),
            Request::RENAME_DIRECTORY { from, to, .. } => (
                root.as_mut()
                    .ok_or("ROOT_REQUIRED")
                    .and_then(|v| v.rename_directory(&from, &to)),
                false,
            ),
            Request::ROLLBACK_DIRECTORY { root_key, .. } => (
                root.as_mut()
                    .ok_or("ROOT_REQUIRED")
                    .and_then(|v| v.rollback_directory(&root_key)),
                false,
            ),
            Request::PREPARE_ATOMIC {
                final_name,
                temporary_name,
                backup_name,
                quarantine_name,
                recovery_name,
                expected_prior,
                content_base64,
                ..
            } => (
                decode_bounded_base64(&content_base64).and_then(|content| {
                    root.as_mut().ok_or("ROOT_REQUIRED").and_then(|v| {
                        v.prepare_atomic(
                            &final_name,
                            &temporary_name,
                            &backup_name,
                            &quarantine_name,
                            &recovery_name,
                            &content,
                            &expected_prior,
                        )
                    })
                }),
                false,
            ),
            Request::MARK_RECOVERY_REQUIRED { .. } => (
                root.as_mut()
                    .ok_or("ROOT_REQUIRED")
                    .and_then(|v| v.mark_recovery_required()),
                false,
            ),
            Request::COMMIT_ATOMIC { .. } => (
                root.as_mut()
                    .ok_or("ROOT_REQUIRED")
                    .and_then(|v| v.settle_atomic(false)),
                false,
            ),
            Request::ROLLBACK_ATOMIC { .. } => (
                root.as_mut()
                    .ok_or("ROOT_REQUIRED")
                    .and_then(|v| v.settle_atomic(true)),
                false,
            ),
            Request::RECOVER_ATOMIC {
                recovery_name,
                decision,
                ..
            } => (
                root.as_mut()
                    .ok_or("ROOT_REQUIRED")
                    .and_then(|v| v.recover_atomic(&recovery_name, &decision)),
                false,
            ),
            Request::SYNC_ROOT { .. } => (
                root.as_ref()
                    .ok_or("ROOT_REQUIRED")
                    .and_then(|v| v.sync())
                    .map(|_| json!({})),
                false,
            ),
            Request::NS_STAT { path, .. } => (
                root.as_mut()
                    .ok_or("ROOT_REQUIRED")
                    .and_then(|v| v.namespace_stat(&path)),
                false,
            ),
            Request::NS_MKDIR { path, .. } => (
                root.as_mut()
                    .ok_or("ROOT_REQUIRED")
                    .and_then(|v| v.namespace_mkdir(&path)),
                false,
            ),
            Request::NS_OPEN {
                path, token, mode, ..
            } => (
                root.as_mut()
                    .ok_or("ROOT_REQUIRED")
                    .and_then(|v| v.namespace_open(&path, &token, &mode)),
                false,
            ),
            Request::NS_READ {
                token,
                offset,
                length,
                ..
            } => (
                root.as_ref()
                    .ok_or("ROOT_REQUIRED")
                    .and_then(|v| v.namespace_read(&token, offset, length)),
                false,
            ),
            Request::NS_WRITE {
                token,
                offset,
                truncate,
                content_base64,
                ..
            } => (
                decode_bounded_base64(&content_base64).and_then(|content| {
                    root.as_mut()
                        .ok_or("ROOT_REQUIRED")
                        .and_then(|v| v.namespace_write(&token, offset, truncate, &content))
                }),
                false,
            ),
            Request::NS_SYNC_HANDLE { token, .. } => (
                root.as_ref()
                    .ok_or("ROOT_REQUIRED")
                    .and_then(|v| v.namespace_sync_handle(&token)),
                false,
            ),
            Request::NS_CLOSE_HANDLE { token, .. } => (
                root.as_mut()
                    .ok_or("ROOT_REQUIRED")
                    .and_then(|v| v.namespace_close_handle(&token)),
                false,
            ),
            Request::NS_RENAME { from, to, .. } => (
                root.as_mut()
                    .ok_or("ROOT_REQUIRED")
                    .and_then(|v| v.namespace_rename(&from, &to)),
                false,
            ),
            Request::NS_UNLINK {
                path, directory, ..
            } => (
                root.as_mut()
                    .ok_or("ROOT_REQUIRED")
                    .and_then(|v| v.namespace_unlink(&path, directory)),
                false,
            ),
            Request::NS_SYNC_DIRECTORY { path, .. } => (
                root.as_mut()
                    .ok_or("ROOT_REQUIRED")
                    .and_then(|v| v.namespace_sync_directory(&path)),
                false,
            ),
            Request::CLOSE { .. } => match root
                .as_mut()
                .ok_or("ROOT_REQUIRED")
                .and_then(|value| value.mark_recovery_required())
            {
                Ok(_) => {
                    root.take();
                    (Ok(json!({"closed":true})), true)
                }
                Err(error) => (Err(error), false),
            },
            _ => (Err("STATE_REJECTED"), false),
        };
        let result = if Instant::now() > deadline {
            Err("DEADLINE")
        } else {
            result
        };
        let reply = match result {
            Ok(value) => json!({"version":1,"id":id,"ok":true,"value":value}),
            Err(code) => json!({"version":1,"id":id,"ok":false,"error":code}),
        };
        if writeln!(out, "{}", reply)
            .and_then(|_| out.flush())
            .is_err()
            || close
        {
            break;
        }
        let _ = deadline_cancel.send(());
    }
}

#[cfg(test)]
mod protocol_tests {
    use super::*;
    #[test]
    fn publication_leaf_contract_is_strict() {
        assert!(valid_leaf("passive-status.sqlite3"));
        for value in ["", ".", "..", "a/b", "a\\b", "trailing.", "trailing "] {
            assert!(!valid_leaf(value));
        }
    }
    #[test]
    fn publication_frames_reject_unknown_fields() {
        assert!(serde_json::from_str::<Request>(
            r#"{"op":"CLOSE","version":1,"id":"a","wait_ms":1}"#
        )
        .is_ok());
        assert!(serde_json::from_str::<Request>(
            r#"{"op":"CLOSE","version":1,"id":"a","wait_ms":1,"secret":"x"}"#
        )
        .is_err());
    }

    #[test]
    fn retained_materialization_publish_and_rollback_are_exact_and_retryable() {
        let root = std::env::temp_dir().join(format!(
            "opencode-publication-state-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let (mut authority, _) = RetainedWindowsRoot::open(root.clone(), false, false).unwrap();
        authority.create_directory("attempt.snapshot").unwrap();
        authority
            .create_child_directory("attempt.snapshot", "attempt.snapshot/config", "config")
            .unwrap();
        authority
            .create_child_file(
                "attempt.snapshot/config",
                "attempt.snapshot/config/opencode.json",
                "opencode.json",
            )
            .unwrap();
        authority
            .write_child_file(
                "attempt.snapshot/config/opencode.json",
                0,
                b"retained",
                true,
            )
            .unwrap();
        assert!(authority
            .write_child_file(
                "attempt.snapshot/config/opencode.json",
                8,
                b"successor",
                true,
            )
            .is_err());
        authority
            .rename_directory("attempt.snapshot", "published")
            .unwrap();
        authority.rollback_directory("attempt.snapshot").unwrap();
        authority.rollback_directory("attempt.snapshot").unwrap();
        assert!(!root.join("published").exists());
        drop(authority);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_evidence_is_retained_until_atomic_rollback_is_durable() {
        let root = std::env::temp_dir().join(format!(
            "opencode-publication-recovery-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("auth.json"), b"prior").unwrap();
        let (mut authority, _) = RetainedWindowsRoot::open(root.clone(), false, false).unwrap();
        authority
            .prepare_atomic(
                "auth.json",
                ".auth.tmp",
                ".auth.backup",
                ".auth.quarantine",
                ".auth.recovery-required",
                b"attempt",
                "any",
            )
            .unwrap();
        authority.mark_recovery_required().unwrap();
        assert!(root.join(".auth.recovery-required").exists());
        authority.settle_atomic(true).unwrap();
        assert_eq!(std::fs::read(root.join("auth.json")).unwrap(), b"prior");
        assert!(!root.join(".auth.recovery-required").exists());
        drop(authority);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn durable_atomic_record_recovers_after_authority_restart() {
        for decision in ["commit", "rollback"] {
            let root = std::env::temp_dir().join(format!(
                "opencode-publication-restart-{}-{}-{decision}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir(&root).unwrap();
            std::fs::write(root.join("auth.json"), b"prior").unwrap();
            {
                let (mut authority, _) =
                    RetainedWindowsRoot::open(root.clone(), false, false).unwrap();
                authority
                    .prepare_atomic(
                        "auth.json",
                        ".auth.tmp",
                        ".auth.backup",
                        ".auth.quarantine",
                        ".auth.recovery-required",
                        b"attempt",
                        "any",
                    )
                    .unwrap();
            }
            let recovery_bytes = std::fs::read(root.join(".auth.recovery-required")).unwrap();
            let records = recovery_bytes
                .split(|value| *value == b'\n')
                .filter(|line| !line.is_empty())
                .map(|line| serde_json::from_slice::<AtomicRecoveryRecord>(line).unwrap())
                .collect::<Vec<_>>();
            assert_eq!(
                records
                    .iter()
                    .map(|record| record.stage.as_str())
                    .collect::<Vec<_>>(),
                [
                    "intent",
                    "preparing",
                    "temporary",
                    "prior_captured",
                    "prior_captured",
                    "published"
                ]
            );
            let record = records.last().unwrap();
            assert_eq!(record.stage, "published");
            assert_eq!(record.final_name, "auth.json");
            assert!(record
                .temporary_file_id
                .as_deref()
                .is_some_and(|value| !value.is_empty()));
            std::fs::OpenOptions::new()
                .append(true)
                .open(root.join(".auth.recovery-required"))
                .unwrap()
                .write_all(b"{\"torn\":")
                .unwrap();
            let (mut successor, _) = RetainedWindowsRoot::open(root.clone(), false, false).unwrap();
            assert_eq!(
                successor
                    .recover_atomic(".auth.recovery-required", decision)
                    .unwrap(),
                json!({"recovered":true})
            );
            assert_eq!(
                std::fs::read(root.join("auth.json")).unwrap(),
                if decision == "commit" {
                    &b"attempt"[..]
                } else {
                    &b"prior"[..]
                }
            );
            assert!(!root.join(".auth.recovery-required").exists());
            drop(successor);
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn intent_record_unwedges_failed_creation_without_adopting_unknown_temporary() {
        let root = std::env::temp_dir().join(format!(
            "opencode-publication-intent-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("auth.json"), b"prior").unwrap();
        std::fs::write(root.join(".auth.tmp"), b"foreign").unwrap();
        {
            let (mut authority, _) = RetainedWindowsRoot::open(root.clone(), false, false).unwrap();
            assert!(authority
                .prepare_atomic(
                    "auth.json",
                    ".auth.tmp",
                    ".auth.backup",
                    ".auth.quarantine",
                    ".auth.recovery-required",
                    b"attempt",
                    "any",
                )
                .is_err());
        }
        let record: AtomicRecoveryRecord = serde_json::from_slice(
            std::fs::read(root.join(".auth.recovery-required"))
                .unwrap()
                .split(|value| *value == b'\n')
                .next()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(record.stage, "intent");
        assert!(record.temporary_file_id.is_none());
        let (mut successor, _) = RetainedWindowsRoot::open(root.clone(), false, false).unwrap();
        assert_eq!(
            successor
                .recover_atomic(".auth.recovery-required", "rollback")
                .unwrap(),
            json!({"recovered":true})
        );
        assert_eq!(std::fs::read(root.join("auth.json")).unwrap(), b"prior");
        assert_eq!(std::fs::read(root.join(".auth.tmp")).unwrap(), b"foreign");
        assert!(!root.join(".auth.recovery-required").exists());
        drop(successor);
        std::fs::remove_dir_all(root).unwrap();
    }
}
