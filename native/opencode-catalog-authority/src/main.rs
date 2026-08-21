//! Short-lived, attempt-owned OpenCode catalog authority.
//!
//! The parent supplies JSON lines and never receives a reply until the SQLite
//! transaction that produced it has committed with synchronous=FULL.  All
//! authority filesystem and SQLite/VFS work lives in this process.

use libsqlite3_sys as sqlite;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::ffi::{CStr, CString};
use std::io::{self, BufRead, Write};
use std::os::raw::{c_char, c_int, c_void};
use std::path::{Component, Path};
use std::ptr;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(unix)]
mod posix_vfs;
#[cfg(windows)]
mod windows_identity;
#[cfg(windows)]
mod windows_vfs;

#[cfg(windows)]
struct WindowsRootComponent {
    path: std::path::PathBuf,
    handle: std::fs::File,
    volume: u64,
    index: u64,
}
#[cfg(windows)]
static WINDOWS_ROOT_HANDLES: std::sync::OnceLock<Vec<WindowsRootComponent>> =
    std::sync::OnceLock::new();
#[cfg(unix)]
struct UnixRootComponent {
    fd: c_int,
    name: String,
    identity: libc::stat,
}
#[cfg(unix)]
static UNIX_ROOT_HANDLES: std::sync::OnceLock<Vec<UnixRootComponent>> = std::sync::OnceLock::new();

#[cfg(unix)]
fn trusted_unix_directory(stat: &libc::stat) -> bool {
    if stat.st_mode & libc::S_IFMT != libc::S_IFDIR {
        return false;
    }
    let writable_by_others = stat.st_mode & 0o022 != 0;
    let owner = stat.st_uid;
    let effective_user = unsafe { libc::geteuid() };

    // Ordinary system ancestors such as `/`, `/usr`, and `/home` are owned by
    // root and are trustworthy when they are not group/other writable.  A
    // root-owned shared directory may be writable only when the sticky bit
    // prevents an unprivileged user from replacing another user's entry.
    if owner == 0 {
        return !writable_by_others || stat.st_mode & libc::S_ISVTX != 0;
    }

    // Every non-system component must be controlled exclusively by the
    // effective user.  In particular, accepting a secure-looking directory
    // owned by a different account would let that account replace it.
    owner == effective_user && !writable_by_others
}

const VERSION: i64 = 44307;
const MAX_ENVELOPE: usize = 2 * 1024 * 1024;
const MAX_ROWS: i64 = 64;
const MAX_BYTES: i64 = 32 * 1024 * 1024;
const MAX_ADMISSIONS: i64 = 128;
const MAX_AUDIT: i64 = 256;
const MAX_GENERATION: i64 = 9_007_199_254_740_991;

fn fault(phase: &str) {
    let selected = std::env::var("OPENCODE_CATALOG_TEST_FAULT").unwrap_or_default();
    if selected == format!("exit:{phase}") {
        std::process::exit(86)
    }
    if selected == format!("stall:{phase}") {
        loop {
            std::thread::park();
        }
    }
}

fn test_gate(phase: &str) {
    if std::env::var("OPENCODE_CATALOG_TEST_GATE_PHASE")
        .ok()
        .as_deref()
        != Some(phase)
    {
        return;
    }
    let Some(gate) = std::env::var_os("OPENCODE_CATALOG_TEST_GATE") else {
        return;
    };
    let gate = std::path::PathBuf::from(gate);
    let mut entered = gate.clone();
    entered.set_extension("entered");
    let mut release = gate;
    release.set_extension("release");
    if std::fs::write(entered, b"").is_err() {
        std::process::exit(86);
    }
    while !release.exists() {
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "SCREAMING_SNAKE_CASE")]
enum Request {
    BeginAttempt {
        id: String,
        wait_ms: u32,
        started_at: i64,
        scope_hash: String,
    },
    BindAndRead {
        id: String,
        wait_ms: u32,
        generation: i64,
        attempt_identity: String,
        identity: Identity,
    },
    Finalize {
        id: String,
        wait_ms: u32,
        generation: i64,
        attempt_identity: String,
        identity: Identity,
        envelope_json: String,
        observed_at: i64,
        expires_at: i64,
    },
    Resolve {
        id: String,
        wait_ms: u32,
        generation: i64,
        attempt_identity: String,
        identity: Identity,
    },
    Close {
        id: String,
        wait_ms: u32,
    },
}

impl Request {
    fn id(&self) -> &str {
        match self {
            Self::BeginAttempt { id, .. }
            | Self::BindAndRead { id, .. }
            | Self::Finalize { id, .. }
            | Self::Resolve { id, .. }
            | Self::Close { id, .. } => id,
        }
    }

    fn deadline(&self) -> Instant {
        let wait_ms = match self {
            Self::BeginAttempt { wait_ms, .. }
            | Self::BindAndRead { wait_ms, .. }
            | Self::Finalize { wait_ms, .. }
            | Self::Resolve { wait_ms, .. }
            | Self::Close { wait_ms, .. } => *wait_ms,
        };
        Instant::now() + Duration::from_millis(u64::from(wait_ms))
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Identity {
    project_path: String,
    provider_id: String,
    config_fingerprint: String,
    auth_fingerprint: String,
    binary_fingerprint: String,
    cache_key: String,
}

struct Db {
    raw: *mut sqlite::sqlite3,
    busy: Box<BusyDeadline>,
}
impl Drop for Db {
    fn drop(&mut self) {
        unsafe {
            sqlite::sqlite3_close(self.raw);
        }
    }
}

struct BusyDeadline {
    deadline: Instant,
}

unsafe extern "C" fn deadline_busy_handler(context: *mut c_void, prior_calls: c_int) -> c_int {
    let state = unsafe { &*(context as *const BusyDeadline) };
    let now = Instant::now();
    if now >= state.deadline {
        return 0;
    }
    // SQLite invokes the handler once per failed lock attempt. Exponential
    // backoff reduces cross-process churn, while the remaining absolute budget
    // caps every sleep and the handler itself decides when waiting ends.
    let shift = u32::try_from(prior_calls.max(0)).unwrap_or(u32::MAX).min(3);
    let backoff = Duration::from_millis(1u64 << shift);
    std::thread::sleep(backoff.min(state.deadline.saturating_duration_since(now)));
    c_int::from(Instant::now() < state.deadline)
}

impl Db {
    fn legacy(raw: *mut sqlite::sqlite3) -> Self {
        Self {
            raw,
            // Legacy snapshot connections are retained-handle, read-only work;
            // they do not participate in authority lock acquisition.
            busy: Box::new(BusyDeadline {
                deadline: Instant::now(),
            }),
        }
    }

    fn set_deadline(&mut self, deadline: Instant) {
        self.busy.deadline = deadline;
    }

    fn check_deadline(&self) -> Result<(), String> {
        if Instant::now() < self.busy.deadline {
            Ok(())
        } else {
            Err("DEADLINE".into())
        }
    }
}

fn fail(id: &str, code: &str) -> Value {
    json!({"version": VERSION, "id": id, "ok": false, "error": code})
}

fn c(value: &str) -> Result<CString, String> {
    CString::new(value).map_err(|_| "NUL".into())
}

#[cfg(all(unix, not(target_os = "macos")))]
unsafe fn unix_errno() -> c_int {
    *libc::__errno_location()
}

#[cfg(target_os = "macos")]
unsafe fn unix_errno() -> c_int {
    *libc::__error()
}

fn sqlite_error(db: *mut sqlite::sqlite3) -> String {
    unsafe {
        CStr::from_ptr(sqlite::sqlite3_errmsg(db))
            .to_string_lossy()
            .into_owned()
    }
}

fn sqlite_result(db: *mut sqlite::sqlite3, rc: c_int) -> String {
    let primary = rc & 0xff;
    if primary == sqlite::SQLITE_BUSY || primary == sqlite::SQLITE_LOCKED {
        "DEADLINE".into()
    } else {
        sqlite_error(db)
    }
}

fn exec(db: &Db, sql: &str) -> Result<(), String> {
    let sql = c(sql)?;
    let mut error: *mut c_char = ptr::null_mut();
    let rc =
        unsafe { sqlite::sqlite3_exec(db.raw, sql.as_ptr(), None, ptr::null_mut(), &mut error) };
    if rc == sqlite::SQLITE_OK {
        return Ok(());
    }
    let message = if error.is_null() {
        sqlite_error(db.raw)
    } else {
        unsafe {
            let value = CStr::from_ptr(error).to_string_lossy().into_owned();
            sqlite::sqlite3_free(error as *mut c_void);
            value
        }
    };
    let primary = unsafe { sqlite::sqlite3_extended_errcode(db.raw) } & 0xff;
    if primary == sqlite::SQLITE_BUSY || primary == sqlite::SQLITE_LOCKED {
        Err("DEADLINE".into())
    } else {
        Err(message)
    }
}

struct Statement {
    db: *mut sqlite::sqlite3,
    ptr: *mut sqlite::sqlite3_stmt,
}
impl Statement {
    fn new(db: &Db, sql: &str) -> Result<Self, String> {
        let sql = c(sql)?;
        let mut ptr = ptr::null_mut();
        let rc = unsafe {
            sqlite::sqlite3_prepare_v2(db.raw, sql.as_ptr(), -1, &mut ptr, ptr::null_mut())
        };
        if rc != sqlite::SQLITE_OK {
            return Err(sqlite_result(db.raw, rc));
        }
        Ok(Self { db: db.raw, ptr })
    }
    fn text(&self, at: c_int, value: &str) -> Result<(), String> {
        let value = c(value)?;
        let rc = unsafe {
            sqlite::sqlite3_bind_text(self.ptr, at, value.as_ptr(), -1, sqlite::SQLITE_TRANSIENT())
        };
        if rc == sqlite::SQLITE_OK {
            Ok(())
        } else {
            Err(sqlite_result(self.db, rc))
        }
    }
    fn int(&self, at: c_int, value: i64) -> Result<(), String> {
        let rc = unsafe { sqlite::sqlite3_bind_int64(self.ptr, at, value) };
        if rc == sqlite::SQLITE_OK {
            Ok(())
        } else {
            Err(sqlite_result(self.db, rc))
        }
    }
    fn step(&self) -> Result<c_int, String> {
        let rc = unsafe { sqlite::sqlite3_step(self.ptr) };
        if rc == sqlite::SQLITE_ROW || rc == sqlite::SQLITE_DONE {
            Ok(rc)
        } else {
            Err(sqlite_result(self.db, rc))
        }
    }
    fn integer(&self, at: c_int) -> i64 {
        unsafe { sqlite::sqlite3_column_int64(self.ptr, at) }
    }
    fn column_type(&self, at: c_int) -> c_int {
        unsafe { sqlite::sqlite3_column_type(self.ptr, at) }
    }
    fn string(&self, at: c_int) -> String {
        unsafe {
            let p = sqlite::sqlite3_column_text(self.ptr, at);
            if p.is_null() {
                String::new()
            } else {
                CStr::from_ptr(p as *const c_char)
                    .to_string_lossy()
                    .into_owned()
            }
        }
    }
}
impl Drop for Statement {
    fn drop(&mut self) {
        unsafe {
            sqlite::sqlite3_finalize(self.ptr);
        }
    }
}

#[cfg(unix)]
fn enter_root(cache_home: &str) -> Result<(), String> {
    use std::os::unix::ffi::OsStrExt;
    let path = Path::new(cache_home);
    if !path.is_absolute() {
        return Err("ROOT_NOT_ABSOLUTE".into());
    }
    let mut fd = unsafe {
        libc::open(
            c("/")?.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err("ROOT_OPEN".into());
    }
    let mut root_identity = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut root_identity) } != 0 {
        return Err("ROOT_STAT".into());
    }
    if !trusted_unix_directory(&root_identity) {
        return Err("ROOT_TRUST".into());
    }
    let mut held = vec![UnixRootComponent {
        fd,
        name: String::new(),
        identity: root_identity,
    }];
    let components = path.components().chain([
        Component::Normal(std::ffi::OsStr::new("opencode")),
        Component::Normal(std::ffi::OsStr::new("provider-catalog-authority-v44307")),
    ]);
    for part in components {
        let name = match part {
            Component::RootDir => continue,
            Component::Normal(v) => v,
            _ => {
                unsafe {
                    libc::close(fd);
                }
                return Err("ROOT_COMPONENT".into());
            }
        };
        let name = CString::new(name.as_bytes()).map_err(|_| "ROOT_COMPONENT".to_string())?;
        let mut next = unsafe {
            libc::openat(
                fd,
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if next < 0 {
            if unsafe { unix_errno() } != libc::ENOENT {
                unsafe {
                    libc::close(fd);
                }
                return Err("ROOT_OPENAT".into());
            }
            if unsafe { libc::mkdirat(fd, name.as_ptr(), 0o700) } != 0 {
                unsafe {
                    libc::close(fd);
                }
                return Err("ROOT_MKDIR".into());
            }
            // First-use acknowledgement is forbidden until the new directory
            // entry is durable in its parent.
            fault("root-before-directory-sync");
            if unsafe { libc::fsync(fd) } != 0 {
                unsafe {
                    libc::close(fd);
                }
                return Err("ROOT_SYNC".into());
            }
            next = unsafe {
                libc::openat(
                    fd,
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if next < 0 {
                unsafe {
                    libc::close(fd);
                }
                return Err("ROOT_REOPEN".into());
            }
        }
        let mut identity = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstat(next, &mut identity) } != 0 {
            return Err("ROOT_STAT".into());
        }
        if !trusted_unix_directory(&identity) {
            return Err("ROOT_TRUST".into());
        }
        held.push(UnixRootComponent {
            fd: next,
            name: name.to_string_lossy().into_owned(),
            identity,
        });
        fd = next;
    }
    if unsafe { libc::fchdir(fd) } != 0 {
        unsafe {
            libc::close(fd);
        }
        return Err("ROOT_CHDIR".into());
    }
    UNIX_ROOT_HANDLES.set(held).map_err(|_| "ROOT_HANDLES")?;
    Ok(())
}

#[cfg(unix)]
fn validate_root() -> Result<(), String> {
    let held = UNIX_ROOT_HANDLES.get().ok_or("ROOT_HANDLES")?;
    for (index, component) in held.iter().enumerate() {
        let mut actual = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstat(component.fd, &mut actual) } != 0
            || actual.st_dev != component.identity.st_dev
            || actual.st_ino != component.identity.st_ino
            || !trusted_unix_directory(&actual)
        {
            return Err("ROOT_REPLACED".into());
        }
        if index > 0 {
            let name = c(&component.name)?;
            let mut named = unsafe { std::mem::zeroed() };
            if unsafe {
                libc::fstatat(
                    held[index - 1].fd,
                    name.as_ptr(),
                    &mut named,
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            } != 0
                || named.st_dev != component.identity.st_dev
                || named.st_ino != component.identity.st_ino
                || !trusted_unix_directory(&named)
            {
                return Err("ROOT_REPLACED".into());
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
fn enter_root(cache_home: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use windows_sys::Win32::Storage::FileSystem::{
        GetDriveTypeW, GetVolumeInformationW, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
        FILE_SHARE_WRITE,
    };
    use windows_sys::Win32::System::WindowsProgramming::DRIVE_FIXED;
    let mut target = std::path::PathBuf::from(cache_home);
    if !target.is_absolute() {
        return Err("ROOT_NOT_ABSOLUTE".into());
    }
    target.push("opencode");
    target.push("provider-catalog-authority-v44307");
    let prefix = match target.components().next() {
        Some(Component::Prefix(value)) => value.as_os_str(),
        _ => return Err("WINDOWS_VOLUME_UNVERIFIED".into()),
    };
    let mut volume_root = prefix.encode_wide().collect::<Vec<_>>();
    volume_root.push('\\' as u16);
    volume_root.push(0);
    if unsafe { GetDriveTypeW(volume_root.as_ptr()) } != DRIVE_FIXED {
        return Err("WINDOWS_VOLUME_UNVERIFIED".into());
    }
    let mut fs_name = [0u16; 32];
    if unsafe {
        GetVolumeInformationW(
            volume_root.as_ptr(),
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            fs_name.as_mut_ptr(),
            fs_name.len() as u32,
        )
    } == 0
    {
        return Err("WINDOWS_VOLUME_UNVERIFIED".into());
    }
    let end = fs_name
        .iter()
        .position(|v| *v == 0)
        .unwrap_or(fs_name.len());
    let fs = String::from_utf16_lossy(&fs_name[..end]);
    if fs != "NTFS" && fs != "ReFS" {
        return Err("WINDOWS_VOLUME_UNVERIFIED".into());
    }
    let mut root_path = std::path::PathBuf::from(prefix);
    root_path.push("\\");
    let root_handle = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(&root_path)
        .map_err(|_| "ROOT_HANDLE")?;
    let root_metadata = root_handle.metadata().map_err(|_| "ROOT_HANDLE")?;
    if !root_metadata.is_dir()
        || root_metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err("ROOT_REPARSE".into());
    }
    let mut cursor = std::path::PathBuf::new();
    let root_identity =
        windows_identity::file_identity(&root_handle).map_err(|_| "ROOT_IDENTITY")?;
    let mut held = vec![WindowsRootComponent {
        path: root_path,
        volume: root_identity.0,
        index: root_identity.1,
        handle: root_handle,
    }];
    for component in target.components() {
        cursor.push(component.as_os_str());
        if matches!(component, Component::Prefix(_) | Component::RootDir) {
            continue;
        }
        if !cursor.exists() {
            std::fs::create_dir(&cursor).map_err(|_| "ROOT_MKDIR")?;
            fault("root-before-directory-sync");
            let parent_path = cursor.parent().ok_or("ROOT_HANDLE")?;
            sync_windows_directory_path(parent_path, "ROOT_SYNC")?;
        }
        let metadata = std::fs::symlink_metadata(&cursor).map_err(|_| "ROOT_METADATA")?;
        if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("ROOT_REPARSE".into());
        }
        let file = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&cursor)
            .map_err(|_| "ROOT_HANDLE")?;
        let opened = file.metadata().map_err(|_| "ROOT_HANDLE")?;
        let opened_identity =
            windows_identity::file_identity(&file).map_err(|_| "ROOT_IDENTITY")?;
        if !opened.is_dir() || opened.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("ROOT_REPLACED".into());
        }
        held.push(WindowsRootComponent {
            path: cursor.clone(),
            volume: opened_identity.0,
            index: opened_identity.1,
            handle: file,
        });
    }
    std::env::set_current_dir(&target).map_err(|_| "ROOT_CHDIR")?;
    WINDOWS_ROOT_HANDLES.set(held).map_err(|_| "ROOT_HANDLES")?;
    Ok(())
}

#[cfg(windows)]
fn validate_windows_root() -> Result<(), String> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    for component in WINDOWS_ROOT_HANDLES.get().ok_or("ROOT_HANDLES")? {
        let held = component.handle.metadata().map_err(|_| "ROOT_REPLACED")?;
        let named_handle = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&component.path)
            .map_err(|_| "ROOT_REPLACED")?;
        let named = named_handle.metadata().map_err(|_| "ROOT_REPLACED")?;
        let held_identity =
            windows_identity::file_identity(&component.handle).map_err(|_| "ROOT_REPLACED")?;
        let named_identity =
            windows_identity::file_identity(&named_handle).map_err(|_| "ROOT_REPLACED")?;
        if !held.is_dir()
            || !named.is_dir()
            || held.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || named.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || held_identity != (component.volume, component.index)
            || named_identity != (component.volume, component.index)
        {
            return Err("ROOT_REPLACED".into());
        }
    }
    Ok(())
}

#[cfg(windows)]
fn sync_windows_directory_path(path: &Path, error: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{
        CloseHandle, GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FlushFileBuffers, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_FLAG_WRITE_THROUGH, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        OPEN_EXISTING,
    };
    let encoded = path
        .as_os_str()
        .encode_wide()
        .chain([0])
        .collect::<Vec<_>>();
    // FlushFileBuffers explicitly requires a handle opened for write.  Never
    // pass the retained read-only trust handles and never reinterpret a failed
    // flush as success: first use/migration remain unavailable until this
    // documented barrier succeeds.
    let handle = unsafe {
        CreateFileW(
            encoded.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(error.into());
    }
    let flushed = unsafe { FlushFileBuffers(handle) } != 0;
    unsafe { CloseHandle(handle) };
    if flushed {
        Ok(())
    } else {
        Err(error.into())
    }
}

fn open_db(deadline: Instant) -> Result<Db, String> {
    fault("vfs-open");
    #[cfg(unix)]
    validate_root()?;
    let filename = c("authority.sqlite")?;
    #[cfg(unix)]
    posix_vfs::register()?;
    #[cfg(windows)]
    windows_vfs::register()?;
    let raw = loop {
        if Instant::now() >= deadline {
            return Err("DEADLINE".into());
        }
        let mut raw = ptr::null_mut();
        let rc = unsafe {
            sqlite::sqlite3_open_v2(
                filename.as_ptr(),
                &mut raw,
                sqlite::SQLITE_OPEN_READWRITE
                    | sqlite::SQLITE_OPEN_CREATE
                    | sqlite::SQLITE_OPEN_FULLMUTEX,
                {
                    #[cfg(unix)]
                    {
                        posix_vfs::name()
                    }
                    #[cfg(windows)]
                    {
                        windows_vfs::name()
                    }
                },
            )
        };
        if rc == sqlite::SQLITE_OK {
            break raw;
        }
        if !raw.is_null() {
            unsafe { sqlite::sqlite3_close(raw) };
        }
        let primary = rc & 0xff;
        if primary != sqlite::SQLITE_BUSY && primary != sqlite::SQLITE_LOCKED {
            return Err("DB_OPEN".into());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("DEADLINE".into());
        }
        std::thread::sleep(Duration::from_millis(1).min(remaining));
    };
    let busy = Box::new(BusyDeadline { deadline });
    let mut db = Db { raw, busy };
    let rc = unsafe {
        sqlite::sqlite3_busy_handler(
            db.raw,
            Some(deadline_busy_handler),
            (&mut *db.busy as *mut BusyDeadline).cast(),
        )
    };
    if rc != sqlite::SQLITE_OK {
        return Err("DB_BUSY_HANDLER".into());
    }
    exec(&db, "PRAGMA journal_mode=PERSIST; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF")?;
    db.check_deadline()?;
    Ok(db)
}

#[cfg(unix)]
fn validate_files(_db: &Db) -> Result<(), String> {
    fault("vfs-read");
    validate_root()?;
    posix_vfs::validate_named_files()?;
    Ok(())
}
#[cfg(windows)]
fn validate_files(_db: &Db) -> Result<(), String> {
    validate_windows_root()?;
    windows_vfs::validate_named_files()
}

fn scalar(db: &Db, sql: &str) -> Result<i64, String> {
    let stmt = Statement::new(db, sql)?;
    if stmt.step()? != sqlite::SQLITE_ROW {
        return Err("NO_ROW".into());
    }
    Ok(stmt.integer(0))
}

fn legacy_table(db: &Db, name: &str) -> Result<bool, String> {
    let statement = Statement::new(
        db,
        "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name=?1",
    )?;
    statement.text(1, name)?;
    statement.step()?;
    Ok(statement.integer(0) == 1)
}

fn normalized_schema(value: &str) -> String {
    value
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .map(|byte| byte.to_ascii_lowercase() as char)
        .collect()
}

fn legacy_schema_sql(db: &Db, name: &str) -> Result<String, String> {
    let statement = Statement::new(
        db,
        "SELECT sql FROM sqlite_schema WHERE type='table' AND name=?1",
    )
    .map_err(|_| "LEGACY_SCHEMA")?;
    statement.text(1, name).map_err(|_| "LEGACY_SCHEMA")?;
    if statement.step().map_err(|_| "LEGACY_SCHEMA")? != sqlite::SQLITE_ROW
        || statement.column_type(0) != sqlite::SQLITE_TEXT
    {
        return Err("LEGACY_SCHEMA".into());
    }
    Ok(normalized_schema(&statement.string(0)))
}

fn validate_legacy_authority(db: &Db, version: i64) -> Result<i64, String> {
    let ticket_44305 = normalized_schema(
        "CREATE TABLE allocation_ticket (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_hash TEXT NOT NULL CHECK(length(scope_hash) = 64),
      started_at INTEGER NOT NULL CHECK(started_at >= 0)
    )",
    );
    let ticket_44306 = normalized_schema(
        "CREATE TABLE allocation_ticket (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_hash TEXT NOT NULL CHECK(length(scope_hash) = 64),
      started_at INTEGER NOT NULL CHECK(started_at >= 0),
      cache_key TEXT CHECK(cache_key IS NULL OR length(cache_key) = 64)
    )",
    );
    let state_schema = normalized_schema(
        "CREATE TABLE allocation_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      generation INTEGER NOT NULL CHECK(generation >= 0)
    )",
    );
    let catalog_schema = normalized_schema(
        "CREATE TABLE catalog_entry (
      cache_key TEXT PRIMARY KEY CHECK(length(cache_key) = 64),
      request_generation INTEGER NOT NULL CHECK(request_generation > 0),
      attempt_identity TEXT NOT NULL CHECK(length(attempt_identity) = 71),
      attempt_id TEXT NOT NULL,
      pointer_json TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      retained_order INTEGER NOT NULL CHECK(retained_order > 0)
    )",
    );
    let expected_objects = if version == 44305 { 3 } else { 4 };
    if scalar(db, "SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_autoindex_%'")
        .map_err(|_| "LEGACY_SCHEMA")?
        != expected_objects
        || scalar(db, "SELECT count(*) FROM sqlite_schema WHERE type IN ('index','trigger','view') AND name NOT LIKE 'sqlite_autoindex_%'")
            .map_err(|_| "LEGACY_SCHEMA")?
            != 0
        || legacy_schema_sql(db, "allocation_state")? != state_schema
        || legacy_schema_sql(db, "allocation_ticket")?
            != if version == 44305 { ticket_44305 } else { ticket_44306 }
        || legacy_schema_sql(db, "sqlite_sequence")?
            != normalized_schema("CREATE TABLE sqlite_sequence(name,seq)")
        || (version == 44306 && legacy_schema_sql(db, "catalog_entry")? != catalog_schema)
        || (version == 44305 && legacy_table(db, "catalog_entry")?)
    {
        return Err("LEGACY_SCHEMA".into());
    }

    let state = Statement::new(db, "SELECT singleton,generation FROM allocation_state")
        .map_err(|_| "LEGACY_LEDGER")?;
    if state.step().map_err(|_| "LEGACY_LEDGER")? != sqlite::SQLITE_ROW
        || state.column_type(0) != sqlite::SQLITE_INTEGER
        || state.column_type(1) != sqlite::SQLITE_INTEGER
        || state.integer(0) != 1
        || !(0..=MAX_GENERATION).contains(&state.integer(1))
    {
        return Err("LEGACY_LEDGER".into());
    }
    let generation = state.integer(1);
    if state.step().map_err(|_| "LEGACY_LEDGER")? != sqlite::SQLITE_DONE {
        return Err("LEGACY_LEDGER".into());
    }
    let expected_count = generation.min(64);
    let expected_minimum = if generation == 0 {
        0
    } else {
        generation - expected_count + 1
    };
    let ledger = Statement::new(
        db,
        "SELECT count(*),coalesce(min(id),0),coalesce(max(id),0),coalesce(sum(id),0) FROM allocation_ticket",
    )
    .map_err(|_| "LEGACY_LEDGER")?;
    if ledger.step().map_err(|_| "LEGACY_LEDGER")? != sqlite::SQLITE_ROW
        || ledger.integer(0) != expected_count
        || ledger.integer(1) != expected_minimum
        || ledger.integer(2) != generation
        || ledger.integer(3) != expected_count * (expected_minimum.saturating_add(generation)) / 2
    {
        return Err("LEGACY_LEDGER".into());
    }
    let tickets = Statement::new(
        db,
        if version == 44305 {
            "SELECT id,scope_hash,started_at,NULL FROM allocation_ticket ORDER BY id"
        } else {
            "SELECT id,scope_hash,started_at,cache_key FROM allocation_ticket ORDER BY id"
        },
    )
    .map_err(|_| "LEGACY_LEDGER")?;
    let mut expected = expected_minimum;
    while tickets.step().map_err(|_| "LEGACY_LEDGER")? == sqlite::SQLITE_ROW {
        let cache_type = tickets.column_type(3);
        if tickets.column_type(0) != sqlite::SQLITE_INTEGER
            || tickets.integer(0) != expected
            || tickets.column_type(1) != sqlite::SQLITE_TEXT
            || !lowercase_hash(&tickets.string(1))
            || tickets.column_type(2) != sqlite::SQLITE_INTEGER
            || tickets.integer(2) < 0
            || (version == 44305 && cache_type != sqlite::SQLITE_NULL)
            || (version == 44306
                && cache_type != sqlite::SQLITE_NULL
                && (cache_type != sqlite::SQLITE_TEXT || !lowercase_hash(&tickets.string(3))))
        {
            return Err("LEGACY_LEDGER".into());
        }
        expected += 1;
    }
    let sequence = Statement::new(db, "SELECT name,seq FROM sqlite_sequence ORDER BY name")
        .map_err(|_| "LEGACY_LEDGER")?;
    if generation == 0 {
        if sequence.step().map_err(|_| "LEGACY_LEDGER")? != sqlite::SQLITE_DONE {
            return Err("LEGACY_LEDGER".into());
        }
    } else if sequence.step().map_err(|_| "LEGACY_LEDGER")? != sqlite::SQLITE_ROW
        || sequence.column_type(0) != sqlite::SQLITE_TEXT
        || sequence.string(0) != "allocation_ticket"
        || sequence.column_type(1) != sqlite::SQLITE_INTEGER
        || sequence.integer(1) != generation
        || sequence.step().map_err(|_| "LEGACY_LEDGER")? != sqlite::SQLITE_DONE
    {
        return Err("LEGACY_LEDGER".into());
    }

    if version == 44306 {
        let rows = Statement::new(db, "SELECT cache_key,request_generation,attempt_identity,attempt_id,pointer_json,envelope_json,retained_order FROM catalog_entry")
            .map_err(|_| "LEGACY_ROW")?;
        while rows.step().map_err(|_| "LEGACY_ROW")? == sqlite::SQLITE_ROW {
            if rows.column_type(0) != sqlite::SQLITE_TEXT
                || !lowercase_hash(&rows.string(0))
                || rows.column_type(1) != sqlite::SQLITE_INTEGER
                || !(1..=generation).contains(&rows.integer(1))
                || rows.column_type(2) != sqlite::SQLITE_TEXT
                || rows
                    .string(2)
                    .strip_prefix("sha256:")
                    .is_none_or(|hash| !lowercase_hash(hash))
                || (3..=5).any(|column| rows.column_type(column) != sqlite::SQLITE_TEXT)
                || rows.column_type(6) != sqlite::SQLITE_INTEGER
                || !(1..=generation).contains(&rows.integer(6))
            {
                return Err("LEGACY_ROW".into());
            }
        }
    }
    Ok(generation)
}

fn legacy_maximum(db: &Db) -> Result<i64, String> {
    let version = scalar(db, "PRAGMA user_version")?;
    validate_legacy_authority(db, version)
}

fn legacy_audit_anchor(db: &Db, high: i64) -> Result<(i64, String), String> {
    let mut sequence = 0;
    let mut previous = format!("{:064x}", 0);
    if legacy_table(db, "audit_anchor")? {
        let anchor = Statement::new(
            db,
            "SELECT pruned_through,anchor_hash FROM audit_anchor WHERE singleton=1",
        )
        .map_err(|_| "LEGACY_AUDIT")?;
        if anchor.step().map_err(|_| "LEGACY_AUDIT")? != sqlite::SQLITE_ROW {
            return Err("LEGACY_AUDIT".into());
        }
        sequence = anchor.integer(0);
        previous = anchor.string(1);
        if sequence < 0 || !lowercase_hash(&previous) {
            return Err("LEGACY_AUDIT".into());
        }
    }
    if !legacy_table(db, "audit_event")? {
        return Ok((sequence, previous));
    }
    let events = Statement::new(
        db,
        "SELECT sequence,generation,kind,payload_hash,previous_hash,event_hash FROM audit_event ORDER BY sequence",
    )
    .map_err(|_| "LEGACY_AUDIT")?;
    while events.step().map_err(|_| "LEGACY_AUDIT")? == sqlite::SQLITE_ROW {
        let next = events.integer(0);
        let generation = events.integer(1);
        let kind = events.string(2);
        let payload = events.string(3);
        let claimed_previous = events.string(4);
        let claimed_event = events.string(5);
        if next != sequence + 1
            || !(0..=high).contains(&generation)
            || kind.is_empty()
            || !lowercase_hash(&payload)
            || claimed_previous != previous
            || !lowercase_hash(&claimed_event)
            || claimed_event
                != sha256_hex(
                    format!("{previous}\0{next}\0{generation}\0{kind}\0{payload}").as_bytes(),
                )
        {
            return Err("LEGACY_AUDIT".into());
        }
        sequence = next;
        previous = claimed_event;
    }
    Ok((sequence, previous))
}

fn schema(db: &Db) -> Result<(), String> {
    fault("migration-open");
    // Serialize all catalog initialization before observing user_version. A
    // contender that read version zero before another process committed could
    // otherwise replay first-use migration over the newly allocated ledger.
    exec(db, "BEGIN IMMEDIATE")?;
    let version = scalar(db, "PRAGMA user_version")?;
    if version == VERSION {
        let initialized = (|| {
            exec(db,"CREATE TABLE IF NOT EXISTS legacy_import(cache_key TEXT NOT NULL, identity_json TEXT NOT NULL, envelope_json TEXT NOT NULL, generation INTEGER NOT NULL, PRIMARY KEY(cache_key,identity_json));
          CREATE TABLE IF NOT EXISTS committed_result(generation INTEGER PRIMARY KEY, attempt_identity TEXT NOT NULL,
            identity_json TEXT NOT NULL, cache_key TEXT NOT NULL, envelope_json TEXT NOT NULL, envelope_bytes INTEGER NOT NULL);
          INSERT OR IGNORE INTO committed_result
            SELECT generation,attempt_identity,identity_json,cache_key,envelope_json,envelope_bytes FROM catalog_entry")?;
            validate(db)
        })();
        return match initialized {
            Ok(()) => {
                exec(db, "COMMIT")?;
                // A crash after the schema COMMIT but before its directory flush is
                // resumed here. No BEGIN acknowledgement is possible until the
                // database/journal directory entries have crossed this durability
                // barrier on a subsequent worker start.
                fault("migration-resume-before-directory-sync");
                sync_directory()
            }
            Err(error) => {
                let _ = exec(db, "ROLLBACK");
                Err(error)
            }
        };
    }
    if version != 0 && version != 44305 && version != 44306 {
        return Err("SCHEMA_VERSION".into());
    }
    if version == 0
        && (scalar(
            db,
            "SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
        )? != 0
            || scalar(db, "PRAGMA page_count")? > 1
            || scalar(db, "PRAGMA freelist_count")? != 0)
    {
        // user_version=0 is not proof of a new database. A dropped, partially
        // initialized, or pre-versioned authority must never be reset to one.
        return Err("VERSION_ZERO_NONEMPTY".into());
    }
    let migrated = (|| {
        let maximum = if version == 0 { 0 } else { legacy_maximum(db)? };
        let (audit_sequence, audit_hash) = if version == 0 {
            (0, format!("{:064x}", 0))
        } else {
            legacy_audit_anchor(db, maximum)?
        };
        let mut legacy = Vec::<(String, String, String, i64)>::new();
        let mut legacy_bytes = 0i64;
        if let Ok(rows)=Statement::new(db,"SELECT length(cache_key),length(identity_json),length(envelope_json),cache_key,identity_json,envelope_json,request_generation FROM catalog_entry ORDER BY request_generation DESC LIMIT 64") {
            while rows.step()?==sqlite::SQLITE_ROW {
                let cache_bytes=rows.integer(0); let identity_bytes=rows.integer(1); let envelope_bytes=rows.integer(2);
                let cache_key=rows.string(3); let encoded_identity=rows.string(4); let generation=rows.integer(6);
                if cache_bytes!=64 || !(0..=131072).contains(&identity_bytes)
                    || !(0..=MAX_ENVELOPE as i64).contains(&envelope_bytes)
                    || !lowercase_hash(&cache_key) || !(0..=maximum).contains(&generation) {
                    return Err("LEGACY_ROW".into());
                }
                let decoded: Identity=serde_json::from_str(&encoded_identity).map_err(|_| "LEGACY_ROW")?;
                if decoded.cache_key != cache_key || identity_json(&decoded)? != encoded_identity {
                    return Err("LEGACY_ROW".into());
                }
                if legacy_bytes + envelope_bytes > MAX_BYTES { continue; }
                legacy_bytes += envelope_bytes;
                legacy.push((cache_key,encoded_identity,rows.string(5),generation));
            }
        } else if version == 44306 {
            let rows=Statement::new(db,"SELECT length(cache_key),length(envelope_json),cache_key,envelope_json,request_generation FROM catalog_entry ORDER BY request_generation DESC LIMIT 64").map_err(|_| "LEGACY_SCHEMA")?;
            while rows.step()?==sqlite::SQLITE_ROW {
                let cache_bytes=rows.integer(0); let envelope_bytes=rows.integer(1);
                let cache_key=rows.string(2); let generation=rows.integer(4);
                if cache_bytes!=64 || !(0..=MAX_ENVELOPE as i64).contains(&envelope_bytes)
                    || !lowercase_hash(&cache_key) || !(0..=maximum).contains(&generation) {
                    return Err("LEGACY_ROW".into());
                }
                if legacy_bytes + envelope_bytes > MAX_BYTES { continue; }
                legacy_bytes += envelope_bytes;
                legacy.push((cache_key,String::new(),rows.string(3),generation));
            }
        }
        exec(
            db,
            "DROP TABLE IF EXISTS catalog_entry; DROP TABLE IF EXISTS allocation_ticket;
          DROP TABLE IF EXISTS allocation_state; DROP TABLE IF EXISTS authority_state;
          DROP TABLE IF EXISTS admission_history; DROP TABLE IF EXISTS audit_event;
          DROP TABLE IF EXISTS audit_anchor; DROP TABLE IF EXISTS migration_state;
          DROP TABLE IF EXISTS legacy_import; DROP TABLE IF EXISTS committed_result",
        )?;
        exec(db, "CREATE TABLE authority_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation INTEGER NOT NULL CHECK(generation>=0));
          CREATE TABLE admission_history(generation INTEGER PRIMARY KEY, started_at INTEGER NOT NULL, scope_hash TEXT NOT NULL,
            attempt_identity TEXT, identity_json TEXT, cache_key TEXT, state TEXT NOT NULL);
          CREATE TABLE catalog_entry(cache_key TEXT PRIMARY KEY, generation INTEGER NOT NULL, attempt_identity TEXT NOT NULL,
            identity_json TEXT NOT NULL, envelope_json TEXT NOT NULL, observed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
            envelope_bytes INTEGER NOT NULL, retained_at INTEGER NOT NULL);
          CREATE TABLE audit_event(sequence INTEGER PRIMARY KEY, generation INTEGER NOT NULL, kind TEXT NOT NULL,
            payload_hash TEXT NOT NULL, previous_hash TEXT NOT NULL, event_hash TEXT NOT NULL);
          CREATE TABLE audit_anchor(singleton INTEGER PRIMARY KEY CHECK(singleton=1), pruned_through INTEGER NOT NULL,
            anchor_hash TEXT NOT NULL);
          CREATE TABLE migration_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1), source_version INTEGER NOT NULL,
            burned_generation INTEGER NOT NULL, complete INTEGER NOT NULL CHECK(complete IN (0,1)));
          CREATE TABLE legacy_import(cache_key TEXT NOT NULL, identity_json TEXT NOT NULL, envelope_json TEXT NOT NULL,
            generation INTEGER NOT NULL, PRIMARY KEY(cache_key,identity_json));
          CREATE TABLE committed_result(generation INTEGER PRIMARY KEY, attempt_identity TEXT NOT NULL,
            identity_json TEXT NOT NULL, cache_key TEXT NOT NULL, envelope_json TEXT NOT NULL, envelope_bytes INTEGER NOT NULL);
          INSERT INTO authority_state VALUES(1,0);
          INSERT INTO migration_state VALUES(1,0,0,0)")?;
        {
            let anchor = Statement::new(db, "INSERT INTO audit_anchor VALUES(1,?1,?2)")?;
            anchor.int(1, audit_sequence)?;
            anchor.text(2, &audit_hash)?;
            anchor.step()?;
        }
        for (cache_key, identity, envelope, generation) in legacy {
            let s = Statement::new(
                db,
                "INSERT OR IGNORE INTO legacy_import VALUES(?1,?2,?3,?4)",
            )?;
            s.text(1, &cache_key)?;
            s.text(2, &identity)?;
            s.text(3, &envelope)?;
            s.int(4, generation)?;
            s.step()?;
        }
        {
            let s = Statement::new(
                db,
                "UPDATE authority_state SET generation=?1 WHERE singleton=1",
            )?;
            s.int(1, maximum)?;
            s.step()?;
        }
        {
            let s=Statement::new(db,"UPDATE migration_state SET source_version=?1,burned_generation=?2,complete=1 WHERE singleton=1")?;
            s.int(1, version)?;
            s.int(2, maximum)?;
            s.step()?;
        }
        exec(db, &format!("PRAGMA user_version={VERSION}"))?;
        Ok::<(), String>(())
    })();
    match migrated {
        Ok(()) => {
            fault("migration-before-commit");
            exec(db, "COMMIT")?;
            fault("migration-after-commit");
            sync_directory()?;
            fault("migration-after-directory-sync");
            validate(db)
        }
        Err(e) => {
            let _ = exec(db, "ROLLBACK");
            Err(e)
        }
    }
}

struct LegacySnapshot {
    version: i64,
    maximum: i64,
    rows: Vec<(String, String, i64)>,
    audit_sequence: i64,
    audit_hash: String,
}

fn legacy_snapshot(legacy: &Db) -> Result<LegacySnapshot, String> {
    let version = scalar(legacy, "PRAGMA user_version")?;
    if version != 44305 && version != 44306 {
        return Err("LEGACY_VERSION".into());
    }
    let maximum = legacy_maximum(legacy)?;
    let (audit_sequence, audit_hash) = legacy_audit_anchor(legacy, maximum)?;
    let mut rows = Vec::new();
    let mut retained_bytes = 0i64;
    if let Ok(statement)=Statement::new(legacy,"SELECT length(cache_key),length(envelope_json),cache_key,envelope_json,request_generation FROM catalog_entry ORDER BY request_generation DESC LIMIT 64") {
      while statement.step()?==sqlite::SQLITE_ROW{
        let cache_bytes=statement.integer(0); let envelope_bytes=statement.integer(1);
        let cache_key=statement.string(2); let generation=statement.integer(4);
        if cache_bytes!=64 || !(0..=MAX_ENVELOPE as i64).contains(&envelope_bytes)
          || !lowercase_hash(&cache_key) || !(0..=maximum).contains(&generation) {
          return Err("LEGACY_ROW".into());
        }
        if retained_bytes + envelope_bytes > MAX_BYTES { continue; }
        retained_bytes += envelope_bytes;
        rows.push((cache_key,statement.string(3),generation));
      }} else if version == 44306 { return Err("LEGACY_SCHEMA".into()); }
    Ok(LegacySnapshot {
        version,
        maximum,
        rows,
        audit_sequence,
        audit_hash,
    })
}

fn apply_external_legacy(authority: &Db, snapshot: LegacySnapshot) -> Result<(), String> {
    let LegacySnapshot {
        version,
        maximum,
        rows,
        audit_sequence,
        audit_hash,
    } = snapshot;
    exec(authority, "BEGIN IMMEDIATE")?;
    let result = (|| {
        let existing_source = scalar(
            authority,
            "SELECT source_version FROM migration_state WHERE singleton=1",
        )?;
        let existing_generation = scalar(
            authority,
            "SELECT generation FROM authority_state WHERE singleton=1",
        )?;
        if existing_source != 0 || existing_generation != 0 {
            let burned = scalar(
                authority,
                "SELECT burned_generation FROM migration_state WHERE singleton=1",
            )?;
            // Another startup may have imported the same retained authority
            // while this process was taking its snapshot. Treat only that exact
            // completed import (possibly followed by newer allocations) as the
            // same initialization; all divergent state remains a hard failure.
            return if existing_source == version
                && burned == maximum
                && existing_generation >= maximum
            {
                Ok(())
            } else {
                Err("MIGRATION_RACE".into())
            };
        }
        let state = Statement::new(
            authority,
            "UPDATE authority_state SET generation=?1 WHERE singleton=1",
        )?;
        state.int(1, maximum)?;
        state.step()?;
        let migration=Statement::new(authority,"UPDATE migration_state SET source_version=?1,burned_generation=?2,complete=1 WHERE singleton=1")?;
        migration.int(1, version)?;
        migration.int(2, maximum)?;
        migration.step()?;
        let anchor = Statement::new(
            authority,
            "UPDATE audit_anchor SET pruned_through=?1,anchor_hash=?2 WHERE singleton=1",
        )?;
        anchor.int(1, audit_sequence)?;
        anchor.text(2, &audit_hash)?;
        anchor.step()?;
        for (cache_key, envelope, generation) in rows {
            let row = Statement::new(
                authority,
                "INSERT OR IGNORE INTO legacy_import VALUES(?1,'',?2,?3)",
            )?;
            row.text(1, &cache_key)?;
            row.text(2, &envelope)?;
            row.int(3, generation)?;
            row.step()?;
        }
        audit(
            authority,
            maximum,
            "MIGRATE_EXTERNAL",
            &format!("v{version}"),
        )?;
        Ok::<(), String>(())
    })();
    match result {
        Ok(()) => {
            exec(authority, "COMMIT")?;
            sync_directory()?;
            validate_files(authority)?;
            Ok(())
        }
        Err(error) => {
            let _ = exec(authority, "ROLLBACK");
            Err(error)
        }
    }
}

#[cfg(unix)]
fn import_external_legacy(authority: &Db) -> Result<(), String> {
    if scalar(
        authority,
        "SELECT source_version FROM migration_state WHERE singleton=1",
    )? != 0
        || scalar(
            authority,
            "SELECT generation FROM authority_state WHERE singleton=1",
        )? != 0
    {
        return Ok(());
    }
    let held = UNIX_ROOT_HANDLES.get().ok_or("ROOT_HANDLES")?;
    if held.len() < 2 {
        return Err("ROOT_HANDLES".into());
    }
    let parent = &held[held.len() - 2];
    let final_root = &held[held.len() - 1];
    let legacy_name = c("provider-catalog-attempts-v2")?;
    let legacy_fd = unsafe {
        libc::openat(
            parent.fd,
            legacy_name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if legacy_fd < 0 {
        return if unsafe { unix_errno() } == libc::ENOENT {
            Ok(())
        } else {
            Err("LEGACY_ROOT_OPEN".into())
        };
    }
    let mut legacy_directory_identity: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(legacy_fd, &mut legacy_directory_identity) } != 0
        || !trusted_unix_directory(&legacy_directory_identity)
    {
        unsafe { libc::close(legacy_fd) };
        return Err("LEGACY_ROOT".into());
    }
    let imported: Result<Option<LegacySnapshot>, String> = (|| {
        if unsafe { libc::fchdir(legacy_fd) } != 0 {
            return Err("LEGACY_CHDIR".into());
        }
        let file = c("attempts.sqlite")?;
        let descriptor = unsafe {
            libc::open(
                file.as_ptr(),
                libc::O_RDWR | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if descriptor < 0 {
            return if unsafe { unix_errno() } == libc::ENOENT {
                Ok(None)
            } else {
                Err("LEGACY_DB_OPEN".into())
            };
        }
        let mut held_identity = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstat(descriptor, &mut held_identity) } != 0
            || held_identity.st_mode & libc::S_IFMT != libc::S_IFREG
            || held_identity.st_uid != unsafe { libc::geteuid() }
            || held_identity.st_mode & 0o022 != 0
        {
            unsafe { libc::close(descriptor) };
            return Err("LEGACY_HANDLE".into());
        }
        let journal_name = c("attempts.sqlite-journal")?;
        let journal_descriptor = unsafe {
            libc::open(
                journal_name.as_ptr(),
                libc::O_RDWR | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        let mut journal_identity: libc::stat = unsafe { std::mem::zeroed() };
        let journal = if journal_descriptor >= 0 {
            if unsafe { libc::fstat(journal_descriptor, &mut journal_identity) } != 0
                || journal_identity.st_mode & libc::S_IFMT != libc::S_IFREG
                || journal_identity.st_uid != unsafe { libc::geteuid() }
                || journal_identity.st_mode & 0o022 != 0
            {
                unsafe {
                    libc::close(journal_descriptor);
                    libc::close(descriptor)
                };
                return Err("LEGACY_JOURNAL_HANDLE".into());
            }
            Some((journal_descriptor, &journal_identity))
        } else if unsafe { unix_errno() } == libc::ENOENT {
            None
        } else {
            unsafe { libc::close(descriptor) };
            return Err("LEGACY_JOURNAL_OPEN".into());
        };
        posix_vfs::set_legacy_handles(descriptor, &held_identity, journal, legacy_fd)?;
        test_gate("legacy-after-handle");
        let mut raw = ptr::null_mut();
        let rc = unsafe {
            sqlite::sqlite3_open_v2(
                file.as_ptr(),
                &mut raw,
                sqlite::SQLITE_OPEN_READWRITE | sqlite::SQLITE_OPEN_FULLMUTEX,
                posix_vfs::name(),
            )
        };
        if rc != sqlite::SQLITE_OK {
            posix_vfs::clear_legacy_handle();
            unsafe { libc::close(descriptor) };
            if journal_descriptor >= 0 {
                unsafe { libc::close(journal_descriptor) };
            }
            return Err("LEGACY_OPEN".into());
        }
        let legacy = Db::legacy(raw);
        let snapshot = legacy_snapshot(&legacy);
        drop(legacy);
        posix_vfs::clear_legacy_handle();
        unsafe { libc::close(descriptor) };
        if journal_descriptor >= 0 {
            unsafe { libc::close(journal_descriptor) };
        }
        Ok(Some(snapshot?))
    })();
    let restored = unsafe { libc::fchdir(final_root.fd) };
    unsafe { libc::close(legacy_fd) };
    if restored != 0 {
        return Err("ROOT_CHDIR".into());
    }
    let Some(snapshot) = imported? else {
        return Ok(());
    };
    apply_external_legacy(authority, snapshot)
}

#[cfg(windows)]
fn import_external_legacy(authority: &Db) -> Result<(), String> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    if scalar(
        authority,
        "SELECT source_version FROM migration_state WHERE singleton=1",
    )? != 0
        || scalar(
            authority,
            "SELECT generation FROM authority_state WHERE singleton=1",
        )? != 0
    {
        return Ok(());
    }
    let directory_path = std::path::PathBuf::from("..").join("provider-catalog-attempts-v2");
    let directory_metadata = match std::fs::symlink_metadata(&directory_path) {
        Ok(v) => v,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("LEGACY_METADATA".into()),
    };
    if !directory_metadata.is_dir()
        || directory_metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err("LEGACY_REPARSE".into());
    }
    let directory = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(&directory_path)
        .map_err(|_| "LEGACY_HANDLE")?;
    let opened_directory = directory.metadata().map_err(|_| "LEGACY_HANDLE")?;
    let directory_identity =
        windows_identity::file_identity(&directory).map_err(|_| "LEGACY_IDENTITY")?;
    if !opened_directory.is_dir()
        || opened_directory.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err("LEGACY_REPLACED".into());
    }
    let path = directory_path.join("attempts.sqlite");
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(v) => v,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("LEGACY_METADATA".into()),
    };
    if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err("LEGACY_REPARSE".into());
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(&path)
        .map_err(|_| "LEGACY_HANDLE")?;
    let expected_identity =
        windows_identity::file_identity(&file).map_err(|_| "LEGACY_IDENTITY")?;
    let encoded = c(&path.to_string_lossy())?;
    let mut raw = ptr::null_mut();
    let rc = unsafe {
        sqlite::sqlite3_open_v2(
            encoded.as_ptr(),
            &mut raw,
            sqlite::SQLITE_OPEN_READONLY | sqlite::SQLITE_OPEN_FULLMUTEX,
            ptr::null(),
        )
    };
    if rc != sqlite::SQLITE_OK {
        if !raw.is_null() {
            unsafe { sqlite::sqlite3_close(raw) };
        }
        return Err("LEGACY_OPEN".into());
    }
    let legacy = Db::legacy(raw);
    let reopened_file = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(&path)
        .map_err(|_| "LEGACY_REPLACED")?;
    let reopened = reopened_file.metadata().map_err(|_| "LEGACY_REPLACED")?;
    let reopened_identity =
        windows_identity::file_identity(&reopened_file).map_err(|_| "LEGACY_REPLACED")?;
    if reopened.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || reopened_identity != expected_identity
    {
        return Err("LEGACY_REPLACED".into());
    }
    let reopened_directory = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(&directory_path)
        .map_err(|_| "LEGACY_REPLACED")?;
    let reopened_directory_metadata = reopened_directory
        .metadata()
        .map_err(|_| "LEGACY_REPLACED")?;
    if !reopened_directory_metadata.is_dir()
        || reopened_directory_metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || windows_identity::file_identity(&reopened_directory).map_err(|_| "LEGACY_REPLACED")?
            != directory_identity
    {
        return Err("LEGACY_REPLACED".into());
    }
    let _held_legacy = (directory, file);
    let snapshot = legacy_snapshot(&legacy)?;
    drop(legacy);
    apply_external_legacy(authority, snapshot)
}

#[cfg(unix)]
fn sync_directory() -> Result<(), String> {
    let dot = c(".")?;
    let fd = unsafe {
        libc::open(
            dot.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err("DIR_OPEN".into());
    }
    let rc = unsafe { libc::fsync(fd) };
    unsafe { libc::close(fd) };
    if rc == 0 {
        Ok(())
    } else {
        Err("DIR_SYNC".into())
    }
}
#[cfg(windows)]
fn sync_directory() -> Result<(), String> {
    let _ = WINDOWS_ROOT_HANDLES.get().ok_or("DIR_HANDLES")?;
    sync_windows_directory_path(Path::new("."), "DIR_SYNC")
}

fn validate(db: &Db) -> Result<(), String> {
    validate_files(db)?;
    if scalar(db, "PRAGMA user_version")? != VERSION {
        return Err("SCHEMA_VERSION".into());
    }
    if scalar(
        db,
        "SELECT count(*) FROM authority_state WHERE singleton=1 AND generation>=0",
    )? != 1
    {
        return Err("STATE".into());
    }
    if scalar(db,"SELECT count(*) FROM sqlite_schema WHERE type='table' AND name IN ('authority_state','admission_history','catalog_entry','audit_event','audit_anchor','migration_state','legacy_import','committed_result')")?!=8
      || scalar(db,"SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND type='table'")?!=8
      || scalar(db,"SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_autoindex_%' AND type IN ('index','trigger','view')")?!=0 {
        return Err("SCHEMA_OBJECTS".into());
    }
    let high = scalar(
        db,
        "SELECT generation FROM authority_state WHERE singleton=1",
    )?;
    if high > MAX_GENERATION {
        return Err("GENERATION_RANGE".into());
    }
    for sql in [
        "SELECT coalesce(max(generation),0) FROM admission_history",
        "SELECT coalesce(max(generation),0) FROM catalog_entry",
        "SELECT coalesce(max(burned_generation),0) FROM migration_state",
    ] {
        if scalar(db, sql)? > high {
            return Err("GENERATION_REGRESSION".into());
        }
    }
    validate_audit_chain(db, high)?;
    if scalar(db, "SELECT count(*) FROM admission_history")? > MAX_ADMISSIONS
        || scalar(db, "SELECT count(*) FROM audit_event")? > MAX_AUDIT
        || scalar(db, "SELECT count(*) FROM catalog_entry")? > MAX_ROWS
        || scalar(db, "SELECT count(*) FROM committed_result")? > MAX_ADMISSIONS
        || scalar(
            db,
            "SELECT coalesce(sum(envelope_bytes),0) FROM catalog_entry",
        )? > MAX_BYTES
    {
        return Err("RETENTION_BOUNDS".into());
    }
    if scalar(db, "SELECT count(*) FROM committed_result WHERE typeof(generation)!='integer' OR generation<1 OR generation>(SELECT generation FROM authority_state WHERE singleton=1) OR typeof(attempt_identity)!='text' OR typeof(identity_json)!='text' OR typeof(cache_key)!='text' OR length(cache_key)!=64 OR typeof(envelope_json)!='text' OR typeof(envelope_bytes)!='integer' OR envelope_bytes<0 OR envelope_bytes>2097152 OR envelope_bytes!=length(CAST(envelope_json AS BLOB))")? != 0
        || scalar(db, "SELECT coalesce(sum(envelope_bytes),0) FROM committed_result")? > MAX_BYTES
    {
        return Err("COMMITTED_RESULT".into());
    }
    let check = Statement::new(db, "PRAGMA quick_check(1)")?;
    if check.step()? != sqlite::SQLITE_ROW || check.string(0) != "ok" {
        return Err("INTEGRITY".into());
    }
    Ok(())
}

fn lowercase_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_audit_chain(db: &Db, high: i64) -> Result<(), String> {
    let anchor = Statement::new(
        db,
        "SELECT pruned_through,anchor_hash FROM audit_anchor WHERE singleton=1",
    )?;
    if anchor.step()? != sqlite::SQLITE_ROW {
        return Err("AUDIT_ANCHOR".into());
    }
    let mut sequence = anchor.integer(0);
    let mut previous = anchor.string(1);
    if sequence < 0 || !lowercase_hash(&previous) {
        return Err("AUDIT_ANCHOR".into());
    }
    let events = Statement::new(
        db,
        "SELECT sequence,generation,kind,payload_hash,previous_hash,event_hash FROM audit_event ORDER BY sequence",
    )?;
    while events.step()? == sqlite::SQLITE_ROW {
        let next = events.integer(0);
        let generation = events.integer(1);
        let kind = events.string(2);
        let payload_hash = events.string(3);
        let claimed_previous = events.string(4);
        let claimed_event = events.string(5);
        if next != sequence + 1
            || generation < 0
            || generation > high
            || kind.is_empty()
            || !lowercase_hash(&payload_hash)
            || claimed_previous != previous
            || !lowercase_hash(&claimed_event)
        {
            return Err("AUDIT_CHAIN".into());
        }
        let expected = sha256_hex(
            format!("{previous}\0{next}\0{generation}\0{kind}\0{payload_hash}").as_bytes(),
        );
        if claimed_event != expected {
            return Err("AUDIT_CHAIN".into());
        }
        sequence = next;
        previous = claimed_event;
    }
    Ok(())
}

fn identity_json(identity: &Identity) -> Result<String, String> {
    let encoded = serde_json::to_string(identity).map_err(|_| "IDENTITY".to_string())?;
    if encoded.len() > 131072
        || !lowercase_hash(&identity.cache_key)
        || [
            &identity.project_path,
            &identity.provider_id,
            &identity.config_fingerprint,
            &identity.auth_fingerprint,
            &identity.binary_fingerprint,
        ]
        .iter()
        .any(|value| value.is_empty() || value.len() > 16_384)
    {
        return Err("IDENTITY".into());
    }
    Ok(encoded)
}

fn audit(db: &Db, generation: i64, kind: &str, payload: &str) -> Result<(), String> {
    let seq = scalar(
        db,
        "SELECT max((SELECT coalesce(max(sequence),0) FROM audit_event),
        (SELECT pruned_through FROM audit_anchor WHERE singleton=1))+1",
    )?;
    let previous = {
        let s = Statement::new(
            db,
            "SELECT event_hash FROM audit_event ORDER BY sequence DESC LIMIT 1",
        )?;
        if s.step()? == sqlite::SQLITE_ROW {
            s.string(0)
        } else {
            let a = Statement::new(db, "SELECT anchor_hash FROM audit_anchor WHERE singleton=1")?;
            a.step()?;
            a.string(0)
        }
    };
    let payload_hash = sha256_hex(payload.as_bytes());
    let event_hash =
        sha256_hex(format!("{previous}\0{seq}\0{generation}\0{kind}\0{payload_hash}").as_bytes());
    let s = Statement::new(db, "INSERT INTO audit_event VALUES(?1,?2,?3,?4,?5,?6)")?;
    s.int(1, seq)?;
    s.int(2, generation)?;
    s.text(3, kind)?;
    s.text(4, &payload_hash)?;
    s.text(5, &previous)?;
    s.text(6, &event_hash)?;
    s.step()?;
    prune_audit(db)?;
    Ok(())
}

fn prune_audit(db: &Db) -> Result<(), String> {
    let cutoff = scalar(
        db,
        &format!("SELECT coalesce(max(sequence),0) FROM (SELECT sequence FROM audit_event ORDER BY sequence DESC LIMIT -1 OFFSET {MAX_AUDIT})"),
    )?;
    if cutoff > 0 {
        let h = Statement::new(db, "SELECT event_hash FROM audit_event WHERE sequence=?1")?;
        h.int(1, cutoff)?;
        h.step()?;
        let hash = h.string(0);
        let u = Statement::new(
            db,
            "UPDATE audit_anchor SET pruned_through=?1,anchor_hash=?2 WHERE singleton=1",
        )?;
        u.int(1, cutoff)?;
        u.text(2, &hash)?;
        u.step()?;
        let d = Statement::new(db, "DELETE FROM audit_event WHERE sequence<=?1")?;
        d.int(1, cutoff)?;
        d.step()?;
    }
    Ok(())
}

fn begin(db: &Db, started: i64, scope: &str) -> Result<Value, String> {
    fault("begin-open");
    if started < 0 || !lowercase_hash(scope) {
        return Err("BEGIN_INPUT".into());
    }
    fault("vfs-lock");
    exec(db, "BEGIN IMMEDIATE")?;
    let result = (|| {
        validate(db)?;
        let current = scalar(
            db,
            "SELECT generation FROM authority_state WHERE singleton=1",
        )?;
        if current >= MAX_GENERATION {
            return Err("GENERATION".into());
        }
        let generation = current + 1;
        let nonce = format!(
            "{}:{}:{}:{}",
            generation,
            started,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let attempt = format!("sha256:{}", sha256_hex(nonce.as_bytes()));
        fault("vfs-write");
        let s = Statement::new(
            db,
            "UPDATE authority_state SET generation=?1 WHERE singleton=1 AND generation=?2",
        )?;
        s.int(1, generation)?;
        s.int(2, current)?;
        s.step()?;
        if unsafe { sqlite::sqlite3_changes(db.raw) } != 1 {
            return Err("FENCE".into());
        }
        let a=Statement::new(db,"INSERT INTO admission_history(generation,started_at,scope_hash,attempt_identity,state) VALUES(?1,?2,?3,?4,'begun')")?;
        a.int(1, generation)?;
        a.int(2, started)?;
        a.text(3, scope)?;
        a.text(4, &attempt)?;
        a.step()?;
        audit(db, generation, "BEGIN_ATTEMPT", scope)?;
        exec(db,&format!("DELETE FROM admission_history WHERE generation IN (SELECT generation FROM admission_history WHERE generation != {generation} ORDER BY generation DESC LIMIT -1 OFFSET {})",MAX_ADMISSIONS-1))?;
        Ok(json!({"generation":generation,"attemptIdentity":attempt}))
    })();
    match result {
        Ok(v) => {
            fault("begin-before-commit");
            fault("vfs-sync");
            fault("vfs-commit");
            exec(db, "COMMIT")?;
            fault("begin-after-commit");
            Ok(v)
        }
        Err(e) => {
            let _ = exec(db, "ROLLBACK");
            Err(e)
        }
    }
}

fn bind(db: &Db, generation: i64, attempt: &str, identity: &Identity) -> Result<Value, String> {
    fault("bind-open");
    let encoded = identity_json(identity)?;
    validate(db)?;
    exec(db, "BEGIN IMMEDIATE")?;
    let result = (|| {
        validate(db)?;
        let high = scalar(
            db,
            "SELECT generation FROM authority_state WHERE singleton=1",
        )?;
        if high != generation {
            return Err("SUPERSEDED".into());
        }
        let s=Statement::new(db,"UPDATE admission_history SET identity_json=?1,cache_key=?2,state='bound' WHERE generation=?3 AND attempt_identity=?4 AND identity_json IS NULL")?;
        s.text(1, &encoded)?;
        s.text(2, &identity.cache_key)?;
        s.int(3, generation)?;
        s.text(4, attempt)?;
        s.step()?;
        if unsafe { sqlite::sqlite3_changes(db.raw) } != 1 {
            return Err("BIND_MISMATCH".into());
        }
        audit(db, generation, "BIND_AND_READ", &encoded)?;
        let prior=Statement::new(db,"SELECT envelope_json,observed_at,expires_at,generation FROM catalog_entry WHERE cache_key=?1 AND identity_json=?2")?;
        prior.text(1, &identity.cache_key)?;
        prior.text(2, &encoded)?;
        let value = if prior.step()? == sqlite::SQLITE_ROW {
            json!({"previousEnvelope":prior.string(0),"observedAt":prior.integer(1),"expiresAt":prior.integer(2),"catalogGeneration":prior.integer(3)})
        } else {
            let legacy=Statement::new(db,"SELECT envelope_json,generation FROM legacy_import WHERE cache_key=?1 AND (identity_json=?2 OR identity_json='')")?;
            legacy.text(1, &identity.cache_key)?;
            legacy.text(2, &encoded)?;
            if legacy.step()? == sqlite::SQLITE_ROW {
                json!({"previousEnvelope":legacy.string(0),"catalogGeneration":legacy.integer(1)})
            } else {
                json!({"previousEnvelope":null})
            }
        };
        Ok(value)
    })();
    match result {
        Ok(v) => {
            exec(db, "COMMIT")?;
            Ok(v)
        }
        Err(e) => {
            let _ = exec(db, "ROLLBACK");
            Err(e)
        }
    }
}

fn finalize(
    db: &Db,
    generation: i64,
    attempt: &str,
    identity: &Identity,
    envelope: &str,
    observed: i64,
    expires: i64,
) -> Result<Value, String> {
    fault("finalize-open");
    if envelope.len() > MAX_ENVELOPE || observed < 0 || expires < observed {
        return Err("ENVELOPE".into());
    }
    let parsed: Value = serde_json::from_str(envelope).map_err(|_| "ENVELOPE_JSON".to_string())?;
    let expected_identity =
        serde_json::to_value(identity).map_err(|_| "ENVELOPE_IDENTITY".to_string())?;
    if parsed["schema"] != "opencode-provider-catalog-cache-v44307"
        || parsed["catalog"]["generation"].as_i64() != Some(generation)
        || parsed["catalogEvidence"]["requestGeneration"].as_i64() != Some(generation)
        || parsed["catalogEvidence"]["attemptIdentity"].as_str() != Some(attempt)
        || parsed["authorityIdentity"] != expected_identity
    {
        return Err("CANDIDATE_MISMATCH".into());
    }
    let encoded = identity_json(identity)?;
    validate(db)?;
    let replay = Statement::new(
        db,
        "SELECT envelope_json FROM committed_result WHERE generation=?1 AND attempt_identity=?2 \
         AND identity_json=?3 AND cache_key=?4",
    )?;
    replay.int(1, generation)?;
    replay.text(2, attempt)?;
    replay.text(3, &encoded)?;
    replay.text(4, &identity.cache_key)?;
    if replay.step()? == sqlite::SQLITE_ROW {
        return if replay.string(0) == envelope {
            Ok(json!({"committed":true,"generation":generation}))
        } else {
            Err("FINALIZE_REPLAY_MISMATCH".into())
        };
    }
    exec(db, "BEGIN IMMEDIATE")?;
    let result = (|| {
        validate(db)?;
        let high = scalar(
            db,
            "SELECT generation FROM authority_state WHERE singleton=1",
        )?;
        if high != generation {
            return Err("SUPERSEDED".into());
        }
        let check=Statement::new(db,"SELECT count(*) FROM admission_history WHERE generation=?1 AND attempt_identity=?2 AND identity_json=?3 AND cache_key=?4 AND state='bound'")?;
        check.int(1, generation)?;
        check.text(2, attempt)?;
        check.text(3, &encoded)?;
        check.text(4, &identity.cache_key)?;
        check.step()?;
        if check.integer(0) != 1 {
            return Err("IDENTITY_MISMATCH".into());
        }
        let s=Statement::new(db,"INSERT INTO catalog_entry VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(cache_key) DO UPDATE SET generation=excluded.generation,attempt_identity=excluded.attempt_identity,identity_json=excluded.identity_json,envelope_json=excluded.envelope_json,observed_at=excluded.observed_at,expires_at=excluded.expires_at,envelope_bytes=excluded.envelope_bytes,retained_at=excluded.retained_at")?;
        s.text(1, &identity.cache_key)?;
        s.int(2, generation)?;
        s.text(3, attempt)?;
        s.text(4, &encoded)?;
        s.text(5, envelope)?;
        s.int(6, observed)?;
        s.int(7, expires)?;
        s.int(8, envelope.len() as i64)?;
        s.int(9, generation)?;
        s.step()?;
        let a=Statement::new(db,"UPDATE admission_history SET state='committed' WHERE generation=?1 AND attempt_identity=?2")?;
        a.int(1, generation)?;
        a.text(2, attempt)?;
        a.step()?;
        let committed =
            Statement::new(db, "INSERT INTO committed_result VALUES(?1,?2,?3,?4,?5,?6)")?;
        committed.int(1, generation)?;
        committed.text(2, attempt)?;
        committed.text(3, &encoded)?;
        committed.text(4, &identity.cache_key)?;
        committed.text(5, envelope)?;
        committed.int(6, envelope.len() as i64)?;
        committed.step()?;
        audit(db, generation, "FINALIZE", &sha256_hex(envelope.as_bytes()))?;
        // Exact deterministic retention: protect this transaction's winner,
        // then remove oldest rows until both limits hold.
        exec(db,&format!("DELETE FROM catalog_entry WHERE cache_key IN (SELECT cache_key FROM catalog_entry WHERE cache_key != '{}' ORDER BY retained_at DESC,cache_key LIMIT -1 OFFSET {})",identity.cache_key.replace('\'',"''"),MAX_ROWS-1))?;
        while scalar(
            db,
            "SELECT coalesce(sum(envelope_bytes),0) FROM catalog_entry",
        )? > MAX_BYTES
        {
            let d=Statement::new(db,"DELETE FROM catalog_entry WHERE cache_key=(SELECT cache_key FROM catalog_entry WHERE cache_key != ?1 ORDER BY retained_at,cache_key LIMIT 1)")?;
            d.text(1, &identity.cache_key)?;
            d.step()?;
            if unsafe { sqlite::sqlite3_changes(db.raw) } == 0 {
                return Err("RETENTION".into());
            }
        }
        exec(db,&format!("DELETE FROM admission_history WHERE generation IN (SELECT generation FROM admission_history WHERE generation != {generation} ORDER BY generation DESC LIMIT -1 OFFSET {})",MAX_ADMISSIONS-1))?;
        exec(db,"DELETE FROM committed_result WHERE generation NOT IN (SELECT generation FROM admission_history)")?;
        while scalar(
            db,
            "SELECT coalesce(sum(envelope_bytes),0) FROM committed_result",
        )? > MAX_BYTES
        {
            let d=Statement::new(db,"DELETE FROM committed_result WHERE generation=(SELECT generation FROM committed_result WHERE generation != ?1 ORDER BY generation LIMIT 1)")?;
            d.int(1, generation)?;
            d.step()?;
            if unsafe { sqlite::sqlite3_changes(db.raw) } == 0 {
                return Err("RETENTION".into());
            }
        }
        // Construct the complete reply before COMMIT.  After COMMIT there are
        // deliberately no validation, cleanup, clock, input, or VFS probes
        // whose failure could reinterpret the acknowledged transaction.
        Ok(json!({"committed":true,"generation":generation}))
    })();
    match result {
        Ok(v) => {
            fault("finalize-before-commit");
            exec(db, "COMMIT")?;
            fault("finalize-after-commit-before-reply");
            Ok(v)
        }
        Err(e) => {
            let _ = exec(db, "ROLLBACK");
            Err(e)
        }
    }
}

fn resolve(db: &Db, generation: i64, attempt: &str, identity: &Identity) -> Result<Value, String> {
    fault("resolve-open");
    if generation < 1 || !attempt.starts_with("sha256:") {
        return Err("RESOLVE_KEY".into());
    }
    validate(db)?;
    let encoded = identity_json(identity)?;
    let admission = Statement::new(
        db,
        "SELECT state FROM admission_history WHERE generation=?1 AND attempt_identity=?2 \
         AND identity_json=?3 AND cache_key=?4",
    )?;
    admission.int(1, generation)?;
    admission.text(2, attempt)?;
    admission.text(3, &encoded)?;
    admission.text(4, &identity.cache_key)?;
    if admission.step()? != sqlite::SQLITE_ROW {
        return Ok(json!({"resolved":false,"generation":generation}));
    }
    if admission.string(0) != "committed" {
        return Ok(json!({"resolved":true,"committed":false,"generation":generation}));
    }
    let catalog = Statement::new(
        db,
        "SELECT envelope_json FROM committed_result WHERE generation=?1 AND attempt_identity=?2 \
         AND identity_json=?3 AND cache_key=?4",
    )?;
    catalog.int(1, generation)?;
    catalog.text(2, attempt)?;
    catalog.text(3, &encoded)?;
    catalog.text(4, &identity.cache_key)?;
    if catalog.step()? != sqlite::SQLITE_ROW {
        return Ok(json!({"resolved":false,"generation":generation}));
    }
    Ok(
        json!({"resolved":true,"committed":true,"generation":generation,
        "envelopeJson":catalog.string(0)}),
    )
}

fn read_bounded_line<R: BufRead>(reader: &mut R, limit: usize) -> io::Result<Option<String>> {
    let mut line = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            if line.is_empty() {
                return Ok(None);
            }
            return String::from_utf8(line)
                .map(Some)
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "protocol utf8"));
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let take = newline.map(|index| index + 1).unwrap_or(available.len());
        let payload = if newline.is_some() { take - 1 } else { take };
        if line.len().saturating_add(payload) > limit {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "protocol line too large",
            ));
        }
        line.extend_from_slice(&available[..payload]);
        reader.consume(take);
        if newline.is_some() {
            return String::from_utf8(line)
                .map(Some)
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "protocol utf8"));
        }
    }
}

fn with_db<T>(
    db: &Option<Db>,
    operation: impl FnOnce(&Db) -> Result<T, String>,
) -> Result<T, String> {
    operation(db.as_ref().ok_or("DB_CLOSED")?)
}

fn main() {
    let cache_home = match std::env::args().nth(1) {
        Some(v) => v,
        None => return,
    };
    let mut db: Option<Db> = None;
    let mut root_entered = false;
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let mut out = io::BufWriter::new(io::stdout().lock());
    loop {
        let line = match read_bounded_line(&mut input, MAX_ENVELOPE * 2 + 262144) {
            Ok(Some(value)) => value,
            Ok(None) | Err(_) => break,
        };
        let request: Request = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => break,
        };
        let request_id = request.id().to_string();
        let deadline = request.deadline();
        let needs_db = !matches!(&request, Request::Close { .. });
        if needs_db && db.is_none() {
            let initialized: Result<Db, String> = (|| -> Result<Db, String> {
                if !root_entered {
                    enter_root(&cache_home)?;
                    root_entered = true;
                }
                let opened = open_db(deadline)?;
                schema(&opened)?;
                opened.check_deadline()?;
                import_external_legacy(&opened)?;
                opened.check_deadline()?;
                Ok(opened)
            })();
            match initialized {
                Ok(opened) => db = Some(opened),
                Err(code) => {
                    let reply = fail(&request_id, &code);
                    let _ = writeln!(out, "{}", reply).and_then(|_| out.flush());
                    break;
                }
            }
        }
        if let Some(current) = db.as_mut() {
            current.set_deadline(deadline);
        }
        let (id, result, close) = match request {
            Request::BeginAttempt {
                id,
                started_at,
                scope_hash,
                ..
            } => {
                let r = with_db(&db, |current| {
                    current.check_deadline()?;
                    begin(current, started_at, &scope_hash)
                });
                (id, r, false)
            }
            Request::BindAndRead {
                id,
                generation,
                attempt_identity,
                identity,
                ..
            } => {
                let r = with_db(&db, |current| {
                    current.check_deadline()?;
                    bind(current, generation, &attempt_identity, &identity)
                });
                (id, r, false)
            }
            Request::Finalize {
                id,
                generation,
                attempt_identity,
                identity,
                envelope_json,
                observed_at,
                expires_at,
                ..
            } => {
                let r = with_db(&db, |current| {
                    current.check_deadline()?;
                    finalize(
                        current,
                        generation,
                        &attempt_identity,
                        &identity,
                        &envelope_json,
                        observed_at,
                        expires_at,
                    )
                });
                (id, r, false)
            }
            Request::Resolve {
                id,
                generation,
                attempt_identity,
                identity,
                ..
            } => {
                let r = with_db(&db, |current| {
                    current.check_deadline()?;
                    resolve(current, generation, &attempt_identity, &identity)
                });
                (id, r, false)
            }
            Request::Close { id, .. } => {
                drop(db.take());
                #[cfg(windows)]
                let _ = windows_vfs::release();
                (id, Ok(json!({"closed":true})), true)
            }
        };
        let reply = match result {
            Ok(value) => json!({"version":VERSION,"id":id,"ok":true,"value":value}),
            Err(code) => fail(&id, &code),
        };
        if writeln!(out, "{}", reply)
            .and_then(|_| out.flush())
            .is_err()
        {
            break;
        }
        if close {
            break;
        }
    }
}

// Compact dependency-free SHA-256 for audit chaining and attempt nonces.
fn sha256_hex(input: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut data = input.to_vec();
    let bits = (data.len() as u64) * 8;
    data.push(0x80);
    while data.len() % 64 != 56 {
        data.push(0)
    }
    data.extend_from_slice(&bits.to_be_bytes());
    let mut h = [
        0x6a09e667u32,
        0xbb67ae85,
        0x3c6ef372,
        0xa54ff53a,
        0x510e527f,
        0x9b05688c,
        0x1f83d9ab,
        0x5be0cd19,
    ];
    for chunk in data.chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes(chunk[i * 4..i * 4 + 4].try_into().unwrap())
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1)
        }
        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2)
        }
        for (i, v) in [a, b, c, d, e, f, g, hh].iter().enumerate() {
            h[i] = h[i].wrapping_add(*v)
        }
    }
    h.iter().map(|v| format!("{v:08x}")).collect()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    struct FixtureRoot {
        path: std::path::PathBuf,
        previous_directory: std::path::PathBuf,
    }

    impl FixtureRoot {
        fn new(label: &str) -> Self {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "catalog-authority-{label}-{}-{nonce}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir(&path).unwrap();
            Self {
                path,
                previous_directory: std::env::current_dir().unwrap(),
            }
        }
    }

    impl Drop for FixtureRoot {
        fn drop(&mut self) {
            let _ = std::env::set_current_dir(&self.previous_directory);
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn protocol_reader_rejects_oversize_before_unbounded_allocation() {
        let mut valid = std::io::Cursor::new(b"abc\nrest".as_slice());
        assert_eq!(
            read_bounded_line(&mut valid, 3).unwrap().as_deref(),
            Some("abc")
        );
        let mut oversized = std::io::Cursor::new(b"abcd\n".as_slice());
        assert_eq!(
            read_bounded_line(&mut oversized, 3).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn unix_trust_accepts_secure_system_ancestors_and_rejects_unsafe_user_paths() {
        let mut directory: libc::stat = unsafe { std::mem::zeroed() };
        directory.st_mode = libc::S_IFDIR | 0o755;
        directory.st_uid = 0;
        assert!(trusted_unix_directory(&directory));
        directory.st_mode = libc::S_IFDIR | 0o1777;
        assert!(trusted_unix_directory(&directory));
        directory.st_uid = unsafe { libc::geteuid() };
        directory.st_mode = libc::S_IFDIR | 0o700;
        assert!(trusted_unix_directory(&directory));
        directory.st_mode = libc::S_IFDIR | 0o770;
        assert!(!trusted_unix_directory(&directory));
        directory.st_uid = unsafe { libc::geteuid() }.saturating_add(1);
        directory.st_mode = libc::S_IFDIR | 0o700;
        assert!(!trusted_unix_directory(&directory));
    }

    #[test]
    fn fixture_root_guard_cleans_after_injected_failure() {
        let mut fixture_path = std::path::PathBuf::new();
        let failed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let fixture = FixtureRoot::new("guard-failure");
            fixture_path = fixture.path.clone();
            panic!("injected fixture failure");
        }));
        assert!(failed.is_err());
        assert!(!fixture_path.exists());
    }

    #[test]
    fn retention_caps_catalog_admissions_and_audit_with_anchor() {
        let fixture = FixtureRoot::new("retention");
        enter_root(fixture.path.to_str().unwrap()).unwrap();
        let db = open_db(Instant::now() + Duration::from_secs(10)).unwrap();
        schema(&db).unwrap();
        assert_eq!(posix_vfs::retained_handle_count(), 2);
        for i in 1..=140i64 {
            let begun = begin(&db, i, &format!("{i:064x}")).unwrap();
            let generation = begun["generation"].as_i64().unwrap();
            let attempt = begun["attemptIdentity"].as_str().unwrap().to_string();
            let identity = Identity {
                project_path: format!("/sandbox/{i}"),
                provider_id: "deepinfra".into(),
                config_fingerprint: "config".into(),
                auth_fingerprint: "auth".into(),
                binary_fingerprint: "binary".into(),
                cache_key: format!("{:064x}", i + 10_000),
            };
            bind(&db, generation, &attempt, &identity).unwrap();
            let envelope=json!({"schema":"opencode-provider-catalog-cache-v44307","authorityIdentity":identity,
              "catalog":{"generation":generation},"catalogEvidence":{"requestGeneration":generation,
              "attemptIdentity":attempt}}).to_string();
            finalize(&db, generation, &attempt, &identity, &envelope, i, i + 1).unwrap();
        }
        assert_eq!(
            scalar(&db, "SELECT count(*) FROM catalog_entry").unwrap(),
            MAX_ROWS
        );
        assert!(scalar(&db, "SELECT count(*) FROM admission_history").unwrap() <= MAX_ADMISSIONS);
        assert!(scalar(&db, "SELECT count(*) FROM audit_event").unwrap() <= MAX_AUDIT);
        assert!(
            scalar(
                &db,
                "SELECT pruned_through FROM audit_anchor WHERE singleton=1"
            )
            .unwrap()
                > 0
        );
        assert!(
            scalar(
                &db,
                "SELECT coalesce(sum(envelope_bytes),0) FROM catalog_entry"
            )
            .unwrap()
                <= MAX_BYTES
        );
        exec(
            &db,
            &format!("UPDATE authority_state SET generation={MAX_GENERATION}"),
        )
        .unwrap();
        assert_eq!(
            begin(&db, 141, &format!("{:064x}", 141)).unwrap_err(),
            "GENERATION"
        );
        exec(&db, "UPDATE authority_state SET generation=140").unwrap();
        exec(
            &db,
            "UPDATE audit_event SET event_hash=printf('%064x',0) WHERE sequence=(SELECT max(sequence) FROM audit_event)",
        )
        .unwrap();
        assert_eq!(validate(&db).unwrap_err(), "AUDIT_CHAIN");
    }
}
