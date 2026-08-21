//! Verifies and launches the packaged authority worker from the actual held
//! executable object. There is intentionally no production pathname fallback.

#[cfg(unix)]
fn main() {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let mut args = std::env::args_os();
    let _ = args.next();
    let worker = match args.next() {
        Some(v) => v,
        None => std::process::exit(125),
    };
    let cache = match args.next() {
        Some(v) => v,
        None => std::process::exit(125),
    };
    if args.next().is_some() {
        std::process::exit(125)
    }
    let path = match CString::new(worker.as_bytes()) {
        Ok(v) => v,
        Err(_) => std::process::exit(125),
    };
    let fd = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        std::process::exit(126)
    }
    let mut stat = unsafe { std::mem::zeroed::<libc::stat>() };
    if unsafe { libc::fstat(fd, &mut stat) } != 0
        || stat.st_mode & libc::S_IFMT != libc::S_IFREG
        || stat.st_uid != unsafe { libc::geteuid() }
        || stat.st_mode & 0o022 != 0
    {
        std::process::exit(126)
    }
    if let Some(gate) = std::env::var_os("OPENCODE_CATALOG_LAUNCHER_TEST_GATE") {
        let gate = std::path::PathBuf::from(gate);
        let mut entered = gate.clone();
        entered.set_extension("entered");
        let mut release = gate;
        release.set_extension("release");
        if std::fs::write(entered, b"").is_err() {
            std::process::exit(126)
        }
        while !release.exists() {
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }
    let arg0 = CString::new("opencode-catalog-authority").unwrap();
    let arg1 = match CString::new(cache.as_bytes()) {
        Ok(v) => v,
        Err(_) => std::process::exit(125),
    };
    let argv = [arg0.as_ptr(), arg1.as_ptr(), std::ptr::null()];
    let mut environment: Vec<CString> = std::env::vars_os()
        .filter_map(|(k, v)| {
            let mut bytes = k.as_bytes().to_vec();
            bytes.push(b'=');
            bytes.extend_from_slice(v.as_bytes());
            CString::new(bytes).ok()
        })
        .collect();
    let mut envp: Vec<*const libc::c_char> = environment.iter_mut().map(|v| v.as_ptr()).collect();
    envp.push(std::ptr::null());
    unsafe { libc::setpgid(0, 0) };
    #[cfg(target_os = "linux")]
    unsafe {
        libc::syscall(
            libc::SYS_execveat,
            fd,
            CString::new("").unwrap().as_ptr(),
            argv.as_ptr(),
            envp.as_ptr(),
            libc::AT_EMPTY_PATH,
        )
    };
    #[cfg(target_os = "macos")]
    unsafe {
        libc::fexecve(fd, argv.as_ptr(), envp.as_ptr())
    };
    std::process::exit(126)
}

#[cfg(windows)]
fn main() {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_SHARE_READ, GENERIC_READ, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::JobObjects::{
        CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
        InitializeProcThreadAttributeList, ResumeThread, TerminateProcess,
        UpdateProcThreadAttribute, WaitForSingleObject, CREATE_NEW_PROCESS_GROUP, CREATE_SUSPENDED,
        EXTENDED_STARTUPINFO_PRESENT, INFINITE, PROCESS_INFORMATION,
        PROC_THREAD_ATTRIBUTE_JOB_LIST, STARTUPINFOEXW,
    };
    let mut args = std::env::args_os();
    let _ = args.next();
    let worker = match args.next() {
        Some(v) => v,
        None => std::process::exit(125),
    };
    let cache = match args.next() {
        Some(v) => v,
        None => std::process::exit(125),
    };
    if args.next().is_some() {
        std::process::exit(125)
    }
    if worker.to_string_lossy().contains('"') || cache.to_string_lossy().contains('"') {
        std::process::exit(125)
    }
    let worker_path = std::path::PathBuf::from(&worker);
    if !worker_path.is_absolute() {
        std::process::exit(126)
    }
    // Retain every named ancestor with share-read only.  Those handles deny
    // both write/delete opens through process creation, while OPEN_REPARSE_POINT
    // lets us reject a pre-existing junction instead of traversing it.
    let mut ancestor_handles = Vec::new();
    let mut cursor = std::path::PathBuf::new();
    for component in worker_path
        .parent()
        .into_iter()
        .flat_map(|p| p.components())
    {
        cursor.push(component.as_os_str());
        if matches!(component, std::path::Component::Prefix(_)) {
            continue;
        }
        let encoded = cursor
            .as_os_str()
            .encode_wide()
            .chain([0])
            .collect::<Vec<_>>();
        let handle = unsafe {
            CreateFileW(
                encoded.as_ptr(),
                GENERIC_READ,
                FILE_SHARE_READ,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                std::ptr::null_mut(),
            )
        };
        let mut information = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
        if handle == INVALID_HANDLE_VALUE
            || unsafe { GetFileInformationByHandle(handle, &mut information) } == 0
            || information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        {
            if handle != INVALID_HANDLE_VALUE {
                unsafe { CloseHandle(handle) };
            }
            std::process::exit(126)
        }
        ancestor_handles.push(handle);
    }
    let mut worker_w = worker.encode_wide().chain([0]).collect::<Vec<_>>();
    let held = unsafe {
        CreateFileW(
            worker_w.as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if held == INVALID_HANDLE_VALUE {
        std::process::exit(126)
    }
    let mut before = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
    if unsafe { GetFileInformationByHandle(held, &mut before) } == 0
        || before.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        std::process::exit(126)
    }
    let command = format!(
        "\"{}\" \"{}\"",
        worker.to_string_lossy(),
        cache.to_string_lossy()
    );
    let mut command_w = std::ffi::OsStr::new(&command)
        .encode_wide()
        .chain([0])
        .collect::<Vec<_>>();
    if let Some(gate) = std::env::var_os("OPENCODE_CATALOG_LAUNCHER_TEST_GATE") {
        let gate = std::path::PathBuf::from(gate);
        let mut entered = gate.clone();
        entered.set_extension("entered");
        let mut release = gate;
        release.set_extension("release");
        if std::fs::write(entered, b"").is_err() {
            std::process::exit(126)
        }
        while !release.exists() {
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }
    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    let mut limits = unsafe { std::mem::zeroed::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if job.is_null()
        || unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            )
        } == 0
    {
        std::process::exit(126)
    }

    let mut attribute_bytes = 0usize;
    unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut attribute_bytes) };
    let mut attribute_storage = vec![
        0usize;
        (attribute_bytes + std::mem::size_of::<usize>() - 1)
            / std::mem::size_of::<usize>()
    ];
    let attributes = attribute_storage.as_mut_ptr() as *mut _;
    if unsafe { InitializeProcThreadAttributeList(attributes, 1, 0, &mut attribute_bytes) } == 0
        || unsafe {
            UpdateProcThreadAttribute(
                attributes,
                0,
                PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
                &job as *const _ as *mut _,
                std::mem::size_of_val(&job),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        } == 0
    {
        std::process::exit(126)
    }
    let mut startup = unsafe { std::mem::zeroed::<STARTUPINFOEXW>() };
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.lpAttributeList = attributes;
    let mut process = unsafe { std::mem::zeroed::<PROCESS_INFORMATION>() };
    let created = unsafe {
        CreateProcessW(
            worker_w.as_mut_ptr(),
            command_w.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP | EXTENDED_STARTUPINFO_PRESENT,
            std::ptr::null(),
            std::ptr::null(),
            &startup.StartupInfo,
            &mut process,
        )
    };
    unsafe { DeleteProcThreadAttributeList(attributes) };
    if created == 0 {
        std::process::exit(126)
    }
    // PROC_THREAD_ATTRIBUTE_JOB_LIST attached the kill-on-close job as part of
    // creation itself. No uncontained suspended-child interval exists.
    if unsafe { ResumeThread(process.hThread) } == u32::MAX {
        unsafe {
            TerminateProcess(process.hProcess, 126);
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
            CloseHandle(job);
            CloseHandle(held);
        }
        std::process::exit(126)
    }
    unsafe {
        CloseHandle(process.hThread);
        WaitForSingleObject(process.hProcess, INFINITE)
    };
    let mut code = 126u32;
    unsafe {
        GetExitCodeProcess(process.hProcess, &mut code);
        CloseHandle(process.hProcess);
        CloseHandle(job);
        CloseHandle(held)
    };
    for handle in ancestor_handles {
        unsafe { CloseHandle(handle) };
    }
    std::process::exit(code as i32)
}
