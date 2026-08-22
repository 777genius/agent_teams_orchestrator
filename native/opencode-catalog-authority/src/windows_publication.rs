use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{self, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};
use windows_sys::Win32::Storage::FileSystem::{
    GetDriveTypeW, GetVolumeInformationW, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
};
use windows_sys::Win32::System::WindowsProgramming::DRIVE_FIXED;

const MAX_WIRE: usize = 64 * 1024;

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
    identity: (u64, u64),
}

struct RetainedWindowsRoot {
    target: PathBuf,
    held: Vec<HeldComponent>,
    pinned: Vec<std::fs::File>,
}

fn open_directory(path: &Path) -> Result<std::fs::File, &'static str> {
    std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|_| "ROOT_REJECTED")
}

fn sync_directory(path: &Path) -> Result<(), &'static str> {
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .and_then(|handle| handle.sync_all())
        .map_err(|_| "ROOT_REJECTED")
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
        let root_handle = open_directory(&root_path)?;
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
        let mut cursor = PathBuf::new();
        let mut created = Vec::new();
        for component in target.components() {
            cursor.push(component.as_os_str());
            if matches!(component, Component::Prefix(_) | Component::RootDir) {
                continue;
            }
            match std::fs::metadata(&cursor) {
                Ok(_) => (),
                Err(error) if error.kind() == io::ErrorKind::NotFound && create => {
                    std::fs::create_dir(&cursor).map_err(|_| "ROOT_REJECTED")?;
                    if durable {
                        sync_directory(&held.last().ok_or("ROOT_REJECTED")?.path)?;
                    }
                    created.push(cursor.to_string_lossy().into_owned());
                }
                Err(_) => return Err("ROOT_REJECTED"),
            }
            let handle = open_directory(&cursor)?;
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
        };
        root.validate()?;
        Ok((root, created))
    }

    fn validate(&self) -> Result<(), &'static str> {
        for component in &self.held {
            let held_meta = component.handle.metadata().map_err(|_| "ROOT_REJECTED")?;
            let named = open_directory(&component.path)?;
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
        sync_directory(&self.target)
    }

    fn pin(&mut self, name: &str, deny_writes: bool) -> Result<Value, &'static str> {
        if !valid_leaf(name) {
            return Err("LEAF_REJECTED");
        }
        self.validate()?;
        let path = self.target.join(name);
        let file = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(if deny_writes {
                // Immutable passive reads retain a content-stable object.
                FILE_SHARE_READ
            } else {
                FILE_SHARE_READ | FILE_SHARE_WRITE
            })
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
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
}

fn valid_leaf(name: &str) -> bool {
    name.len() <= 255 && valid_component(name)
}

#[cfg(test)]
mod tests {
    use super::{valid_leaf, valid_root_input};

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
        name: String,
    },
    PIN_REGULAR_READONLY {
        version: u8,
        id: String,
        wait_ms: u32,
        name: String,
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
            | Self::SYNC_ROOT {
                version,
                id,
                wait_ms,
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
        if version != 1 || id.is_empty() || id.len() > 64 || !id.is_ascii() || wait_ms == 0 {
            break;
        }
        let deadline = Instant::now() + Duration::from_millis(wait_ms as u64);
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
            Request::PIN_REGULAR { name, .. } => (
                root.as_mut()
                    .ok_or("ROOT_REQUIRED")
                    .and_then(|v| v.pin(&name, false)),
                false,
            ),
            Request::PIN_REGULAR_READONLY { name, .. } => (
                root.as_mut()
                    .ok_or("ROOT_REQUIRED")
                    .and_then(|v| v.pin(&name, true)),
                false,
            ),
            Request::SYNC_ROOT { .. } => (
                root.as_ref()
                    .ok_or("ROOT_REQUIRED")
                    .and_then(|v| v.sync())
                    .map(|_| json!({})),
                false,
            ),
            Request::CLOSE { .. } => {
                root.take();
                (Ok(json!({"closed":true})), true)
            }
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
    }
}

#[cfg(test)]
mod tests {
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
}
