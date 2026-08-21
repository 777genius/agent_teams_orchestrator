//! Authority-only Windows SQLite VFS.
//!
//! The first open retains a read/write handle whose share mode permits reads
//! only. SQLite receives clones of that exact object, so unrelated pathname
//! opens cannot write, delete, or replace the database or persistent journal
//! while an authority worker performs a database operation.

use super::{fault, sync_directory, windows_identity};
use libsqlite3_sys as sqlite;
use std::ffi::CStr;
use std::fs::{File, OpenOptions};
use std::os::raw::{c_char, c_int, c_void};
use std::os::windows::fs::{FileExt, MetadataExt, OpenOptionsExt};
use std::os::windows::io::AsRawHandle;
use std::ptr;
use std::sync::{Mutex, OnceLock};
use windows_sys::Win32::Foundation::{GetLastError, ERROR_LOCK_VIOLATION, HANDLE};
use windows_sys::Win32::Storage::FileSystem::{
    LockFileEx, UnlockFileEx, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_FLAG_WRITE_THROUGH, FILE_SHARE_READ, FILE_SHARE_WRITE, LOCKFILE_EXCLUSIVE_LOCK,
    LOCKFILE_FAIL_IMMEDIATELY,
};
use windows_sys::Win32::System::IO::OVERLAPPED;

const PENDING_BYTE: u64 = 0x4000_0000;
const RESERVED_BYTE: u64 = PENDING_BYTE + 1;
const SHARED_FIRST: u64 = PENDING_BYTE + 2;
const SHARED_SIZE: u64 = 510;

type Held = (String, File, u64, u64);
static REGISTERED: OnceLock<()> = OnceLock::new();
static HELD: OnceLock<Mutex<Vec<Held>>> = OnceLock::new();

#[repr(C)]
struct AuthorityFile {
    base: sqlite::sqlite3_file,
    file: *mut File,
    lock: c_int,
    name: [u8; 32],
}

fn held() -> &'static Mutex<Vec<Held>> {
    HELD.get_or_init(|| Mutex::new(Vec::new()))
}

fn known_name(raw: *const c_char) -> Result<&'static str, c_int> {
    if raw.is_null() {
        return Err(sqlite::SQLITE_CANTOPEN);
    }
    let bytes = unsafe { CStr::from_ptr(raw) }.to_bytes();
    let leaf = bytes
        .rsplit(|byte| *byte == b'/' || *byte == b'\\')
        .next()
        .unwrap_or(bytes);
    match leaf {
        b"authority.sqlite" => Ok("authority.sqlite"),
        b"authority.sqlite-journal" => Ok("authority.sqlite-journal"),
        _ => Err(sqlite::SQLITE_CANTOPEN),
    }
}

fn identity(file: &File) -> Result<(u64, u64), c_int> {
    let metadata = file.metadata().map_err(|_| sqlite::SQLITE_IOERR_FSTAT)?;
    if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(sqlite::SQLITE_CANTOPEN);
    }
    windows_identity::file_identity(file).map_err(|_| sqlite::SQLITE_IOERR_FSTAT)
}

pub(super) fn validate_named_files() -> Result<(), String> {
    let handles = held().lock().map_err(|_| "VFS_IDENTITY".to_string())?;
    for (name, retained, volume, index) in handles.iter() {
        let replacement = if name.ends_with("-journal") {
            "JOURNAL_REPLACED"
        } else {
            "DB_REPLACED"
        };
        let retained_identity = identity(retained).map_err(|_| replacement.to_string())?;
        let named = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(name)
            .map_err(|_| replacement)?;
        let metadata = named.metadata().map_err(|_| replacement)?;
        let named_identity = identity(&named).map_err(|_| replacement.to_string())?;
        if !metadata.is_file()
            || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || named_identity != (*volume, *index)
            || retained_identity != (*volume, *index)
        {
            return Err(replacement.into());
        }
    }
    Ok(())
}

/// Release the retained baselines only when the attempt closes.  SQLite byte
/// locks coordinate peer authorities; denying delete while allowing writes
/// keeps the exact DB/journal objects stable from BEGIN through CLOSE.
pub(super) fn release() -> Result<(), String> {
    held()
        .lock()
        .map_err(|_| "VFS_RELEASE".to_string())?
        .clear();
    Ok(())
}

unsafe fn authority_file<'a>(raw: *mut sqlite::sqlite3_file) -> &'a mut AuthorityFile {
    &mut *(raw as *mut AuthorityFile)
}

unsafe fn file<'a>(raw: *mut sqlite::sqlite3_file) -> &'a mut File {
    &mut *authority_file(raw).file
}

unsafe extern "C" fn io_close(raw: *mut sqlite::sqlite3_file) -> c_int {
    let authority = authority_file(raw);
    if authority.name.starts_with(b"authority.sqlite\0") {
        fault("vfs-close");
    }
    if !authority.file.is_null() {
        drop(Box::from_raw(authority.file));
        authority.file = ptr::null_mut();
    }
    authority.base.pMethods = ptr::null();
    sqlite::SQLITE_OK
}

unsafe extern "C" fn io_read(
    raw: *mut sqlite::sqlite3_file,
    destination: *mut c_void,
    amount: c_int,
    offset: sqlite::sqlite3_int64,
) -> c_int {
    fault("vfs-read");
    let output = std::slice::from_raw_parts_mut(destination as *mut u8, amount as usize);
    let mut done = 0usize;
    while done < output.len() {
        match file(raw).seek_read(&mut output[done..], offset as u64 + done as u64) {
            Ok(0) => {
                output[done..].fill(0);
                return sqlite::SQLITE_IOERR_SHORT_READ;
            }
            Ok(count) => done += count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return sqlite::SQLITE_IOERR_READ,
        }
    }
    sqlite::SQLITE_OK
}

unsafe extern "C" fn io_write(
    raw: *mut sqlite::sqlite3_file,
    source: *const c_void,
    amount: c_int,
    offset: sqlite::sqlite3_int64,
) -> c_int {
    fault("vfs-write");
    let input = std::slice::from_raw_parts(source as *const u8, amount as usize);
    let mut done = 0usize;
    while done < input.len() {
        match file(raw).seek_write(&input[done..], offset as u64 + done as u64) {
            Ok(0) => return sqlite::SQLITE_IOERR_WRITE,
            Ok(count) => done += count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return sqlite::SQLITE_IOERR_WRITE,
        }
    }
    sqlite::SQLITE_OK
}

unsafe extern "C" fn io_truncate(
    raw: *mut sqlite::sqlite3_file,
    size: sqlite::sqlite3_int64,
) -> c_int {
    match file(raw).set_len(size as u64) {
        Ok(()) => sqlite::SQLITE_OK,
        Err(_) => sqlite::SQLITE_IOERR_TRUNCATE,
    }
}

unsafe extern "C" fn io_sync(raw: *mut sqlite::sqlite3_file, _flags: c_int) -> c_int {
    fault("vfs-sync");
    match file(raw).sync_all() {
        Ok(()) => sqlite::SQLITE_OK,
        Err(_) => sqlite::SQLITE_IOERR_FSYNC,
    }
}

unsafe extern "C" fn io_size(
    raw: *mut sqlite::sqlite3_file,
    output: *mut sqlite::sqlite3_int64,
) -> c_int {
    match file(raw).metadata() {
        Ok(metadata) => {
            *output = metadata.len() as i64;
            sqlite::SQLITE_OK
        }
        Err(_) => sqlite::SQLITE_IOERR_FSTAT,
    }
}

unsafe fn overlapped(offset: u64) -> OVERLAPPED {
    let mut value = OVERLAPPED::default();
    value.Anonymous.Anonymous.Offset = offset as u32;
    value.Anonymous.Anonymous.OffsetHigh = (offset >> 32) as u32;
    value
}

unsafe fn set_lock(file: &File, kind: c_int, offset: u64, length: u64) -> c_int {
    let mut operation = overlapped(offset);
    if kind == 0 {
        return if UnlockFileEx(
            file.as_raw_handle() as HANDLE,
            0,
            length as u32,
            (length >> 32) as u32,
            &mut operation,
        ) != 0
        {
            sqlite::SQLITE_OK
        } else {
            sqlite::SQLITE_IOERR_UNLOCK
        };
    }
    let flags = LOCKFILE_FAIL_IMMEDIATELY
        | if kind == 2 {
            LOCKFILE_EXCLUSIVE_LOCK
        } else {
            0
        };
    if LockFileEx(
        file.as_raw_handle() as HANDLE,
        flags,
        0,
        length as u32,
        (length >> 32) as u32,
        &mut operation,
    ) != 0
    {
        sqlite::SQLITE_OK
    } else if GetLastError() == ERROR_LOCK_VIOLATION {
        sqlite::SQLITE_BUSY
    } else {
        sqlite::SQLITE_IOERR_LOCK
    }
}

unsafe extern "C" fn io_lock(raw: *mut sqlite::sqlite3_file, target: c_int) -> c_int {
    fault("vfs-lock");
    let mut current = authority_file(raw).lock;
    if target <= current {
        return sqlite::SQLITE_OK;
    }
    if current < sqlite::SQLITE_LOCK_SHARED && target >= sqlite::SQLITE_LOCK_SHARED {
        let mut result = set_lock(file(raw), 2, PENDING_BYTE, 1);
        if result == sqlite::SQLITE_OK {
            result = set_lock(file(raw), 1, SHARED_FIRST, SHARED_SIZE);
            let _ = set_lock(file(raw), 0, PENDING_BYTE, 1);
        }
        if result != sqlite::SQLITE_OK {
            return result;
        }
        current = sqlite::SQLITE_LOCK_SHARED;
        authority_file(raw).lock = current;
    }
    if target >= sqlite::SQLITE_LOCK_RESERVED && current < sqlite::SQLITE_LOCK_RESERVED {
        let result = set_lock(file(raw), 2, RESERVED_BYTE, 1);
        if result != sqlite::SQLITE_OK {
            return result;
        }
        current = sqlite::SQLITE_LOCK_RESERVED;
        authority_file(raw).lock = current;
    }
    if target >= sqlite::SQLITE_LOCK_PENDING && current < sqlite::SQLITE_LOCK_PENDING {
        let result = set_lock(file(raw), 2, PENDING_BYTE, 1);
        if result != sqlite::SQLITE_OK {
            return result;
        }
        current = sqlite::SQLITE_LOCK_PENDING;
        authority_file(raw).lock = current;
    }
    if target >= sqlite::SQLITE_LOCK_EXCLUSIVE && current < sqlite::SQLITE_LOCK_EXCLUSIVE {
        let _ = set_lock(file(raw), 0, SHARED_FIRST, SHARED_SIZE);
        let result = set_lock(file(raw), 2, SHARED_FIRST, SHARED_SIZE);
        if result != sqlite::SQLITE_OK {
            if set_lock(file(raw), 1, SHARED_FIRST, SHARED_SIZE) != sqlite::SQLITE_OK {
                return sqlite::SQLITE_IOERR_LOCK;
            }
            return result;
        }
        authority_file(raw).lock = sqlite::SQLITE_LOCK_EXCLUSIVE;
    }
    sqlite::SQLITE_OK
}

unsafe extern "C" fn io_unlock(raw: *mut sqlite::sqlite3_file, target: c_int) -> c_int {
    let current = authority_file(raw).lock;
    if target >= current {
        return sqlite::SQLITE_OK;
    }
    if target == sqlite::SQLITE_LOCK_SHARED {
        let _ = set_lock(file(raw), 0, SHARED_FIRST, SHARED_SIZE);
        if set_lock(file(raw), 1, SHARED_FIRST, SHARED_SIZE) != sqlite::SQLITE_OK {
            return sqlite::SQLITE_IOERR_UNLOCK;
        }
        let _ = set_lock(file(raw), 0, RESERVED_BYTE, 1);
        let _ = set_lock(file(raw), 0, PENDING_BYTE, 1);
    } else if target == sqlite::SQLITE_LOCK_NONE {
        let _ = set_lock(file(raw), 0, SHARED_FIRST, SHARED_SIZE);
        let _ = set_lock(file(raw), 0, RESERVED_BYTE, 1);
        let _ = set_lock(file(raw), 0, PENDING_BYTE, 1);
    }
    authority_file(raw).lock = target;
    sqlite::SQLITE_OK
}

unsafe extern "C" fn io_reserved(raw: *mut sqlite::sqlite3_file, output: *mut c_int) -> c_int {
    if authority_file(raw).lock >= sqlite::SQLITE_LOCK_RESERVED {
        *output = 1;
        return sqlite::SQLITE_OK;
    }
    let result = set_lock(file(raw), 2, RESERVED_BYTE, 1);
    if result == sqlite::SQLITE_OK {
        let _ = set_lock(file(raw), 0, RESERVED_BYTE, 1);
        *output = 0;
        sqlite::SQLITE_OK
    } else if result == sqlite::SQLITE_BUSY {
        *output = 1;
        sqlite::SQLITE_OK
    } else {
        sqlite::SQLITE_IOERR_CHECKRESERVEDLOCK
    }
}

unsafe extern "C" fn io_control(
    raw: *mut sqlite::sqlite3_file,
    operation: c_int,
    argument: *mut c_void,
) -> c_int {
    if operation == sqlite::SQLITE_FCNTL_LOCKSTATE {
        *(argument as *mut c_int) = authority_file(raw).lock;
        sqlite::SQLITE_OK
    } else {
        sqlite::SQLITE_NOTFOUND
    }
}

unsafe extern "C" fn io_sector(_raw: *mut sqlite::sqlite3_file) -> c_int {
    4096
}
unsafe extern "C" fn io_characteristics(_raw: *mut sqlite::sqlite3_file) -> c_int {
    0
}

static IO_METHODS: sqlite::sqlite3_io_methods = sqlite::sqlite3_io_methods {
    iVersion: 1,
    xClose: Some(io_close),
    xRead: Some(io_read),
    xWrite: Some(io_write),
    xTruncate: Some(io_truncate),
    xSync: Some(io_sync),
    xFileSize: Some(io_size),
    xLock: Some(io_lock),
    xUnlock: Some(io_unlock),
    xCheckReservedLock: Some(io_reserved),
    xFileControl: Some(io_control),
    xSectorSize: Some(io_sector),
    xDeviceCharacteristics: Some(io_characteristics),
    xShmMap: None,
    xShmLock: None,
    xShmBarrier: None,
    xShmUnmap: None,
    xFetch: None,
    xUnfetch: None,
};

fn open_named(name: &str, flags: c_int) -> Result<File, c_int> {
    let existing = {
        let handles = held().lock().map_err(|_| sqlite::SQLITE_IOERR)?;
        handles
            .iter()
            .find(|(candidate, _, _, _)| candidate == name)
            .map(|(_, file, _, _)| file.try_clone())
            .transpose()
            .map_err(|_| sqlite::SQLITE_CANTOPEN)?
    };
    if let Some(file) = existing {
        validate_named_files().map_err(|_| sqlite::SQLITE_CANTOPEN)?;
        return Ok(file);
    }
    let options = |create_new: bool| {
        let mut value = OpenOptions::new();
        value
            .read(true)
            .write(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH);
        if create_new {
            value.create_new(true);
        } else if flags & sqlite::SQLITE_OPEN_CREATE != 0 {
            value.create(true);
        }
        value
    };
    let mut created = false;
    let file = if name == "authority.sqlite-journal" && flags & sqlite::SQLITE_OPEN_CREATE != 0 {
        match options(true).open(name) {
            Ok(file) => {
                created = true;
                file
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::AlreadyExists
                    && flags & sqlite::SQLITE_OPEN_EXCLUSIVE == 0 =>
            {
                options(false)
                    .open(name)
                    .map_err(|_| sqlite::SQLITE_CANTOPEN)?
            }
            Err(_) => return Err(sqlite::SQLITE_CANTOPEN),
        }
    } else {
        options(flags & sqlite::SQLITE_OPEN_EXCLUSIVE != 0)
            .open(name)
            .map_err(|_| sqlite::SQLITE_CANTOPEN)?
    };
    let (volume, index) = identity(&file)?;
    if created {
        fault("journal-before-directory-sync");
        sync_directory().map_err(|_| sqlite::SQLITE_IOERR_DIR_FSYNC)?;
        fault("journal-after-directory-sync");
    }
    let guard = file.try_clone().map_err(|_| sqlite::SQLITE_CANTOPEN)?;
    held()
        .lock()
        .map_err(|_| sqlite::SQLITE_IOERR)?
        .push((name.to_string(), guard, volume, index));
    Ok(file)
}

unsafe extern "C" fn vfs_open(
    _vfs: *mut sqlite::sqlite3_vfs,
    name: *const c_char,
    raw: *mut sqlite::sqlite3_file,
    flags: c_int,
    output_flags: *mut c_int,
) -> c_int {
    fault("vfs-open");
    let name = match known_name(name) {
        Ok(value) => value,
        Err(error) => return error,
    };
    let file = match open_named(name, flags) {
        Ok(value) => value,
        Err(error) => return error,
    };
    let authority = authority_file(raw);
    ptr::write_bytes(authority as *mut AuthorityFile, 0, 1);
    authority.base.pMethods = &IO_METHODS;
    authority.file = Box::into_raw(Box::new(file));
    authority.lock = sqlite::SQLITE_LOCK_NONE;
    authority.name[..name.len()].copy_from_slice(name.as_bytes());
    if !output_flags.is_null() {
        *output_flags = flags;
    }
    sqlite::SQLITE_OK
}

unsafe extern "C" fn vfs_delete(
    _vfs: *mut sqlite::sqlite3_vfs,
    name: *const c_char,
    sync: c_int,
) -> c_int {
    let name = match known_name(name) {
        Ok(value) => value,
        Err(error) => return error,
    };
    if name != "authority.sqlite-journal" || validate_named_files().is_err() {
        return sqlite::SQLITE_IOERR_DELETE;
    }
    {
        let mut handles = match held().lock() {
            Ok(value) => value,
            Err(_) => return sqlite::SQLITE_IOERR_DELETE,
        };
        handles.retain(|(candidate, _, _, _)| candidate != name);
    }
    match std::fs::remove_file(name) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return sqlite::SQLITE_IOERR_DELETE,
    }
    if sync != 0 && sync_directory().is_err() {
        return sqlite::SQLITE_IOERR_DIR_FSYNC;
    }
    sqlite::SQLITE_OK
}

unsafe extern "C" fn vfs_access(
    _vfs: *mut sqlite::sqlite3_vfs,
    name: *const c_char,
    _flags: c_int,
    output: *mut c_int,
) -> c_int {
    let name = match known_name(name) {
        Ok(value) => value,
        Err(_) => {
            *output = 0;
            return sqlite::SQLITE_OK;
        }
    };
    *output = match std::fs::symlink_metadata(name) {
        Ok(metadata)
            if metadata.is_file()
                && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0 =>
        {
            1
        }
        Ok(_) | Err(_) => 0,
    };
    sqlite::SQLITE_OK
}

unsafe extern "C" fn vfs_full_path(
    _vfs: *mut sqlite::sqlite3_vfs,
    name: *const c_char,
    size: c_int,
    output: *mut c_char,
) -> c_int {
    let leaf = match known_name(name) {
        Ok(value) => value,
        Err(error) => return error,
    };
    if leaf.len() + 1 > size as usize {
        return sqlite::SQLITE_CANTOPEN;
    }
    ptr::copy_nonoverlapping(leaf.as_ptr() as *const c_char, output, leaf.len());
    *output.add(leaf.len()) = 0;
    sqlite::SQLITE_OK
}

unsafe extern "C" fn vfs_random(
    _vfs: *mut sqlite::sqlite3_vfs,
    amount: c_int,
    output: *mut c_char,
) -> c_int {
    let mut state = std::process::id() as u64
        ^ std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64;
    for index in 0..amount as usize {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        *output.add(index) = state as c_char;
    }
    amount
}

unsafe extern "C" fn vfs_sleep(_vfs: *mut sqlite::sqlite3_vfs, micros: c_int) -> c_int {
    std::thread::sleep(std::time::Duration::from_micros(micros.max(0) as u64));
    micros
}

unsafe extern "C" fn vfs_time(_vfs: *mut sqlite::sqlite3_vfs, output: *mut f64) -> c_int {
    let unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    *output = 2_440_587.5 + unix.as_secs_f64() / 86_400.0;
    sqlite::SQLITE_OK
}

unsafe extern "C" fn vfs_error(
    _vfs: *mut sqlite::sqlite3_vfs,
    _size: c_int,
    _output: *mut c_char,
) -> c_int {
    0
}

pub(super) fn register() -> Result<(), String> {
    if REGISTERED.get().is_some() {
        return Ok(());
    }
    static NAME: &[u8] = b"opencode-authority-windows-v44307\0";
    let vfs = Box::new(sqlite::sqlite3_vfs {
        iVersion: 1,
        szOsFile: std::mem::size_of::<AuthorityFile>() as c_int,
        mxPathname: 32_768,
        pNext: ptr::null_mut(),
        zName: NAME.as_ptr() as *const c_char,
        pAppData: ptr::null_mut(),
        xOpen: Some(vfs_open),
        xDelete: Some(vfs_delete),
        xAccess: Some(vfs_access),
        xFullPathname: Some(vfs_full_path),
        xDlOpen: None,
        xDlError: None,
        xDlSym: None,
        xDlClose: None,
        xRandomness: Some(vfs_random),
        xSleep: Some(vfs_sleep),
        xCurrentTime: Some(vfs_time),
        xGetLastError: Some(vfs_error),
        xCurrentTimeInt64: None,
        xSetSystemCall: None,
        xGetSystemCall: None,
        xNextSystemCall: None,
    });
    let leaked = Box::into_raw(vfs);
    if unsafe { sqlite::sqlite3_vfs_register(leaked, 0) } != sqlite::SQLITE_OK {
        unsafe { drop(Box::from_raw(leaked)) };
        return Err("VFS_REGISTER".into());
    }
    REGISTERED.set(()).map_err(|_| "VFS_REGISTER".to_string())
}

pub(super) fn name() -> *const c_char {
    b"opencode-authority-windows-v44307\0".as_ptr() as *const c_char
}
