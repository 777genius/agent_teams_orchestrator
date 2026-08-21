//! Minimal authority-only POSIX SQLite VFS.
//!
//! SQLite never resolves an authority pathname itself. Every database and
//! persistent-journal open is an `openat` beneath the root directory retained
//! by `enter_root`, with no-follow and an identity check at the VFS use gate.

use super::{c, fault, unix_errno, UNIX_ROOT_HANDLES};
use libsqlite3_sys as sqlite;
use std::ffi::CStr;
use std::os::raw::{c_char, c_int, c_void};
use std::ptr;
use std::sync::{Mutex, OnceLock};

const PENDING_BYTE: i64 = 0x4000_0000;
const RESERVED_BYTE: i64 = PENDING_BYTE + 1;
const SHARED_FIRST: i64 = PENDING_BYTE + 2;
const SHARED_SIZE: i64 = 510;

static REGISTERED: OnceLock<()> = OnceLock::new();
static IDENTITIES: OnceLock<Mutex<Vec<(String, u64, u64)>>> = OnceLock::new();
static HELD_HANDLES: OnceLock<Mutex<Vec<(String, c_int)>>> = OnceLock::new();
static LEGACY_HANDLE: OnceLock<Mutex<Option<(c_int, u64, u64)>>> = OnceLock::new();

#[repr(C)]
struct AuthorityFile {
    base: sqlite::sqlite3_file,
    fd: c_int,
    lock: c_int,
    shared_byte: i64,
    name: [u8; 32],
}

fn identities() -> &'static Mutex<Vec<(String, u64, u64)>> {
    IDENTITIES.get_or_init(|| Mutex::new(Vec::new()))
}

fn held_handles() -> &'static Mutex<Vec<(String, c_int)>> {
    HELD_HANDLES.get_or_init(|| Mutex::new(Vec::new()))
}

fn legacy_handle() -> &'static Mutex<Option<(c_int, u64, u64)>> {
    LEGACY_HANDLE.get_or_init(|| Mutex::new(None))
}

pub(super) fn set_legacy_handle(fd: c_int, stat: &libc::stat) -> Result<(), String> {
    let guard = unsafe { libc::dup(fd) };
    if guard < 0 {
        return Err("LEGACY_HANDLE".into());
    }
    let mut slot = legacy_handle().lock().map_err(|_| "LEGACY_HANDLE")?;
    if let Some((old, _, _)) = slot.replace((guard, stat.st_dev as u64, stat.st_ino as u64)) {
        unsafe { libc::close(old) };
    }
    Ok(())
}

pub(super) fn clear_legacy_handle() {
    if let Ok(mut slot) = legacy_handle().lock() {
        if let Some((fd, _, _)) = slot.take() {
            unsafe { libc::close(fd) };
        }
    }
}

fn root_fd() -> Result<c_int, c_int> {
    UNIX_ROOT_HANDLES
        .get()
        .and_then(|held| held.last())
        .map(|entry| entry.fd)
        .ok_or(sqlite::SQLITE_CANTOPEN)
}

unsafe fn authority_file<'a>(file: *mut sqlite::sqlite3_file) -> &'a mut AuthorityFile {
    &mut *(file as *mut AuthorityFile)
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
        b"attempts.sqlite" => Ok("attempts.sqlite"),
        _ => Err(sqlite::SQLITE_CANTOPEN),
    }
}

fn remember_identity(name: &str, stat: &libc::stat) -> Result<(), c_int> {
    let mut values = identities().lock().map_err(|_| sqlite::SQLITE_IOERR)?;
    if let Some((_, device, inode)) = values.iter().find(|(candidate, _, _)| candidate == name) {
        if *device != stat.st_dev as u64 || *inode != stat.st_ino as u64 {
            return Err(sqlite::SQLITE_CANTOPEN);
        }
    } else {
        values.push((name.to_string(), stat.st_dev as u64, stat.st_ino as u64));
    }
    Ok(())
}

pub(super) fn validate_named_files() -> Result<(), String> {
    let root = root_fd().map_err(|_| "VFS_ROOT".to_string())?;
    let values = identities()
        .lock()
        .map_err(|_| "VFS_IDENTITY".to_string())?;
    for (name, device, inode) in values.iter() {
        let encoded = c(name)?;
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstatat(root, encoded.as_ptr(), &mut stat, libc::AT_SYMLINK_NOFOLLOW) }
            != 0
            || stat.st_mode & libc::S_IFMT != libc::S_IFREG
            || stat.st_uid != unsafe { libc::geteuid() }
            || stat.st_mode & 0o022 != 0
            || stat.st_dev as u64 != *device
            || stat.st_ino as u64 != *inode
        {
            return Err("DB_REPLACED".into());
        }
    }
    Ok(())
}

unsafe extern "C" fn io_close(raw: *mut sqlite::sqlite3_file) -> c_int {
    let file = authority_file(raw);
    if file.name.starts_with(b"authority.sqlite\0") {
        fault("vfs-close");
    }
    let result = if file.fd >= 0 {
        libc::close(file.fd)
    } else {
        0
    };
    file.fd = -1;
    file.base.pMethods = ptr::null();
    if result == 0 {
        sqlite::SQLITE_OK
    } else {
        sqlite::SQLITE_IOERR_CLOSE
    }
}

unsafe extern "C" fn io_read(
    raw: *mut sqlite::sqlite3_file,
    destination: *mut c_void,
    amount: c_int,
    offset: sqlite::sqlite3_int64,
) -> c_int {
    fault("vfs-read");
    let file = authority_file(raw);
    let mut done = 0usize;
    while done < amount as usize {
        let rc = libc::pread(
            file.fd,
            (destination as *mut u8).add(done) as *mut c_void,
            amount as usize - done,
            offset + done as i64,
        );
        if rc > 0 {
            done += rc as usize;
            continue;
        }
        if rc < 0 && unix_errno() == libc::EINTR {
            continue;
        }
        if rc < 0 {
            return sqlite::SQLITE_IOERR_READ;
        }
        ptr::write_bytes(
            (destination as *mut u8).add(done),
            0,
            amount as usize - done,
        );
        return sqlite::SQLITE_IOERR_SHORT_READ;
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
    let file = authority_file(raw);
    let mut done = 0usize;
    while done < amount as usize {
        let rc = libc::pwrite(
            file.fd,
            (source as *const u8).add(done) as *const c_void,
            amount as usize - done,
            offset + done as i64,
        );
        if rc > 0 {
            done += rc as usize;
            continue;
        }
        if rc < 0 && unix_errno() == libc::EINTR {
            continue;
        }
        return sqlite::SQLITE_IOERR_WRITE;
    }
    sqlite::SQLITE_OK
}

unsafe extern "C" fn io_truncate(
    raw: *mut sqlite::sqlite3_file,
    size: sqlite::sqlite3_int64,
) -> c_int {
    if libc::ftruncate(authority_file(raw).fd, size) == 0 {
        sqlite::SQLITE_OK
    } else {
        sqlite::SQLITE_IOERR_TRUNCATE
    }
}

unsafe extern "C" fn io_sync(raw: *mut sqlite::sqlite3_file, _flags: c_int) -> c_int {
    fault("vfs-sync");
    if libc::fsync(authority_file(raw).fd) == 0 {
        sqlite::SQLITE_OK
    } else {
        sqlite::SQLITE_IOERR_FSYNC
    }
}

unsafe extern "C" fn io_size(
    raw: *mut sqlite::sqlite3_file,
    output: *mut sqlite::sqlite3_int64,
) -> c_int {
    let mut stat: libc::stat = std::mem::zeroed();
    if libc::fstat(authority_file(raw).fd, &mut stat) != 0 {
        return sqlite::SQLITE_IOERR_FSTAT;
    }
    *output = stat.st_size;
    sqlite::SQLITE_OK
}

unsafe fn set_lock(fd: c_int, kind: c_int, start: i64, length: i64) -> c_int {
    let mut lock = libc::flock {
        l_type: kind as _,
        l_whence: libc::SEEK_SET as _,
        l_start: start,
        l_len: length,
        l_pid: 0,
    };
    if libc::fcntl(fd, libc::F_SETLK, &mut lock) == 0 {
        sqlite::SQLITE_OK
    } else {
        sqlite::SQLITE_BUSY
    }
}

unsafe extern "C" fn io_lock(raw: *mut sqlite::sqlite3_file, target: c_int) -> c_int {
    fault("vfs-lock");
    let file = authority_file(raw);
    if target <= file.lock {
        return sqlite::SQLITE_OK;
    }
    if file.lock < sqlite::SQLITE_LOCK_SHARED && target >= sqlite::SQLITE_LOCK_SHARED {
        let mut rc = set_lock(file.fd, libc::F_RDLCK as _, PENDING_BYTE, 1);
        if rc == sqlite::SQLITE_OK {
            rc = set_lock(file.fd, libc::F_RDLCK as _, file.shared_byte, 1);
            let _ = set_lock(file.fd, libc::F_UNLCK as _, PENDING_BYTE, 1);
        }
        if rc != sqlite::SQLITE_OK {
            return rc;
        }
        file.lock = sqlite::SQLITE_LOCK_SHARED;
    }
    if target >= sqlite::SQLITE_LOCK_RESERVED && file.lock < sqlite::SQLITE_LOCK_RESERVED {
        let rc = set_lock(file.fd, libc::F_WRLCK as _, RESERVED_BYTE, 1);
        if rc != sqlite::SQLITE_OK {
            return rc;
        }
        file.lock = sqlite::SQLITE_LOCK_RESERVED;
    }
    if target >= sqlite::SQLITE_LOCK_PENDING && file.lock < sqlite::SQLITE_LOCK_PENDING {
        let rc = set_lock(file.fd, libc::F_WRLCK as _, PENDING_BYTE, 1);
        if rc != sqlite::SQLITE_OK {
            return rc;
        }
        file.lock = sqlite::SQLITE_LOCK_PENDING;
    }
    if target >= sqlite::SQLITE_LOCK_EXCLUSIVE && file.lock < sqlite::SQLITE_LOCK_EXCLUSIVE {
        let rc = set_lock(file.fd, libc::F_WRLCK as _, SHARED_FIRST, SHARED_SIZE);
        if rc != sqlite::SQLITE_OK {
            return rc;
        }
        file.lock = sqlite::SQLITE_LOCK_EXCLUSIVE;
    }
    sqlite::SQLITE_OK
}

unsafe extern "C" fn io_unlock(raw: *mut sqlite::sqlite3_file, target: c_int) -> c_int {
    let file = authority_file(raw);
    if target >= file.lock {
        return sqlite::SQLITE_OK;
    }
    if target == sqlite::SQLITE_LOCK_SHARED {
        let _ = set_lock(file.fd, libc::F_UNLCK as _, SHARED_FIRST, SHARED_SIZE);
        if set_lock(file.fd, libc::F_RDLCK as _, file.shared_byte, 1) != sqlite::SQLITE_OK {
            return sqlite::SQLITE_IOERR_UNLOCK;
        }
        let _ = set_lock(file.fd, libc::F_UNLCK as _, RESERVED_BYTE, 1);
        let _ = set_lock(file.fd, libc::F_UNLCK as _, PENDING_BYTE, 1);
    } else if target == sqlite::SQLITE_LOCK_NONE {
        let _ = set_lock(file.fd, libc::F_UNLCK as _, SHARED_FIRST, SHARED_SIZE);
        let _ = set_lock(file.fd, libc::F_UNLCK as _, RESERVED_BYTE, 1);
        let _ = set_lock(file.fd, libc::F_UNLCK as _, PENDING_BYTE, 1);
    }
    file.lock = target;
    sqlite::SQLITE_OK
}

unsafe extern "C" fn io_reserved(raw: *mut sqlite::sqlite3_file, output: *mut c_int) -> c_int {
    let file = authority_file(raw);
    if file.lock >= sqlite::SQLITE_LOCK_RESERVED {
        *output = 1;
        return sqlite::SQLITE_OK;
    }
    let mut lock = libc::flock {
        l_type: libc::F_WRLCK as _,
        l_whence: libc::SEEK_SET as _,
        l_start: RESERVED_BYTE,
        l_len: 1,
        l_pid: 0,
    };
    if libc::fcntl(file.fd, libc::F_GETLK, &mut lock) != 0 {
        return sqlite::SQLITE_IOERR_CHECKRESERVEDLOCK;
    }
    *output = if lock.l_type == libc::F_UNLCK as libc::c_short {
        0
    } else {
        1
    };
    sqlite::SQLITE_OK
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
    if name == "attempts.sqlite" {
        if flags & sqlite::SQLITE_OPEN_READONLY == 0
            || flags & (sqlite::SQLITE_OPEN_CREATE | sqlite::SQLITE_OPEN_READWRITE) != 0
        {
            return sqlite::SQLITE_READONLY;
        }
        let fd = match legacy_handle().lock() {
            Ok(slot) => match *slot {
                Some((held, device, inode)) => {
                    let duplicate = libc::dup(held);
                    let mut stat: libc::stat = std::mem::zeroed();
                    if duplicate < 0
                        || libc::fstat(duplicate, &mut stat) != 0
                        || stat.st_dev as u64 != device
                        || stat.st_ino as u64 != inode
                    {
                        if duplicate >= 0 {
                            libc::close(duplicate);
                        }
                        return sqlite::SQLITE_CANTOPEN;
                    }
                    duplicate
                }
                None => return sqlite::SQLITE_CANTOPEN,
            },
            Err(_) => return sqlite::SQLITE_IOERR,
        };
        let file = authority_file(raw);
        ptr::write_bytes(file as *mut AuthorityFile, 0, 1);
        file.base.pMethods = &IO_METHODS;
        file.fd = fd;
        file.lock = sqlite::SQLITE_LOCK_NONE;
        file.shared_byte = SHARED_FIRST + (libc::getpid() as i64 % SHARED_SIZE);
        file.name[..name.len()].copy_from_slice(name.as_bytes());
        if !output_flags.is_null() {
            *output_flags = sqlite::SQLITE_OPEN_READONLY;
        }
        return sqlite::SQLITE_OK;
    }
    let mut open_flags = libc::O_CLOEXEC | libc::O_NOFOLLOW;
    // The journal may first be probed during hot-journal recovery with
    // read-only flags and then reopened for the next transaction. Retaining
    // that first descriptor as read-only would make the later pwrite fail
    // with EBADF, so every authority-owned file is opened read/write.
    open_flags |= libc::O_RDWR;
    if flags & sqlite::SQLITE_OPEN_CREATE != 0 {
        open_flags |= libc::O_CREAT;
    }
    if flags & sqlite::SQLITE_OPEN_EXCLUSIVE != 0 {
        open_flags |= libc::O_EXCL;
    }
    let encoded = match c(name) {
        Ok(value) => value,
        Err(_) => return sqlite::SQLITE_CANTOPEN,
    };
    let retained = match held_handles().lock() {
        Ok(handles) => handles
            .iter()
            .find(|(candidate, _)| candidate == name)
            .map(|(_, fd)| *fd),
        Err(_) => return sqlite::SQLITE_IOERR,
    };
    let fd = if let Some(retained) = retained {
        if validate_named_files().is_err() {
            return sqlite::SQLITE_CANTOPEN;
        }
        libc::dup(retained)
    } else {
        libc::openat(
            match root_fd() {
                Ok(value) => value,
                Err(error) => return error,
            },
            encoded.as_ptr(),
            open_flags,
            0o600,
        )
    };
    if fd < 0 {
        return sqlite::SQLITE_CANTOPEN;
    }
    let mut stat: libc::stat = std::mem::zeroed();
    if libc::fstat(fd, &mut stat) != 0
        || stat.st_mode & libc::S_IFMT != libc::S_IFREG
        || stat.st_uid != libc::geteuid()
        || stat.st_mode & 0o022 != 0
        || remember_identity(name, &stat).is_err()
    {
        libc::close(fd);
        return sqlite::SQLITE_CANTOPEN;
    }
    if retained.is_none() {
        let guard = libc::dup(fd);
        if guard < 0 {
            libc::close(fd);
            return sqlite::SQLITE_CANTOPEN;
        }
        match held_handles().lock() {
            Ok(mut handles) => handles.push((name.to_string(), guard)),
            Err(_) => {
                libc::close(guard);
                libc::close(fd);
                return sqlite::SQLITE_IOERR;
            }
        }
    }
    let file = authority_file(raw);
    ptr::write_bytes(file as *mut AuthorityFile, 0, 1);
    file.base.pMethods = &IO_METHODS;
    file.fd = fd;
    file.lock = sqlite::SQLITE_LOCK_NONE;
    file.shared_byte = SHARED_FIRST + (libc::getpid() as i64 % SHARED_SIZE);
    file.name[..name.len()].copy_from_slice(name.as_bytes());
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
    if name != "authority.sqlite-journal" {
        return sqlite::SQLITE_IOERR_DELETE;
    }
    if validate_named_files().is_err() {
        return sqlite::SQLITE_IOERR_DELETE;
    }
    let encoded = match c(name) {
        Ok(value) => value,
        Err(_) => return sqlite::SQLITE_IOERR_DELETE,
    };
    if libc::unlinkat(
        match root_fd() {
            Ok(value) => value,
            Err(error) => return error,
        },
        encoded.as_ptr(),
        0,
    ) != 0
        && unix_errno() != libc::ENOENT
    {
        return sqlite::SQLITE_IOERR_DELETE;
    }
    if let Ok(mut values) = identities().lock() {
        values.retain(|(candidate, _, _)| candidate != name);
    } else {
        return sqlite::SQLITE_IOERR_DELETE;
    }
    if let Ok(mut handles) = held_handles().lock() {
        if let Some(index) = handles.iter().position(|(candidate, _)| candidate == name) {
            let (_, fd) = handles.remove(index);
            libc::close(fd);
        }
    } else {
        return sqlite::SQLITE_IOERR_DELETE;
    }
    if sync != 0 && libc::fsync(root_fd().unwrap_or(-1)) != 0 {
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
    if name == "attempts.sqlite" {
        *output = legacy_handle()
            .lock()
            .map(|slot| slot.is_some())
            .unwrap_or(false) as c_int;
        return sqlite::SQLITE_OK;
    }
    let encoded = match c(name) {
        Ok(value) => value,
        Err(_) => return sqlite::SQLITE_IOERR_ACCESS,
    };
    let mut stat: libc::stat = std::mem::zeroed();
    *output = if libc::fstatat(
        root_fd().unwrap_or(-1),
        encoded.as_ptr(),
        &mut stat,
        libc::AT_SYMLINK_NOFOLLOW,
    ) == 0
        && stat.st_mode & libc::S_IFMT == libc::S_IFREG
    {
        1
    } else {
        0
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
    let mut state = (libc::getpid() as u64) ^ (libc::time(ptr::null_mut()) as u64).rotate_left(17);
    for index in 0..amount as usize {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        *output.add(index) = state as c_char;
    }
    amount
}
unsafe extern "C" fn vfs_sleep(_vfs: *mut sqlite::sqlite3_vfs, micros: c_int) -> c_int {
    libc::usleep(micros as u32);
    micros
}
unsafe extern "C" fn vfs_time(_vfs: *mut sqlite::sqlite3_vfs, output: *mut f64) -> c_int {
    let mut time: libc::timeval = std::mem::zeroed();
    libc::gettimeofday(&mut time, ptr::null_mut());
    *output = 2_440_587.5 + time.tv_sec as f64 / 86_400.0 + time.tv_usec as f64 / 86_400_000_000.0;
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
    static NAME: &[u8] = b"opencode-authority-posix-v44307\0";
    let vfs = Box::new(sqlite::sqlite3_vfs {
        iVersion: 1,
        szOsFile: std::mem::size_of::<AuthorityFile>() as c_int,
        mxPathname: 4096,
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
        unsafe {
            drop(Box::from_raw(leaked));
        }
        return Err("VFS_REGISTER".into());
    }
    REGISTERED.set(()).map_err(|_| "VFS_REGISTER".to_string())
}

pub(super) fn name() -> *const c_char {
    b"opencode-authority-posix-v44307\0".as_ptr() as *const c_char
}

#[cfg(test)]
pub(super) fn retained_handle_count() -> usize {
    held_handles()
        .lock()
        .map(|handles| handles.len())
        .unwrap_or(0)
}
