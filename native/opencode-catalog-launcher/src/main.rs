//! Verifies and launches the packaged authority worker from the actual held
//! executable object. There is intentionally no production pathname fallback.

#[cfg(windows)]
const WINDOWS_VOLUME_IDENTITY_UNVERIFIED: &str =
    "OPENCODE_LAUNCH_WINDOWS_VOLUME_IDENTITY_UNVERIFIED";

#[cfg(any(windows, test))]
fn windows_process_birth_token(sequence_number: u64, creation_filetime: u64) -> String {
    format!("windows:{sequence_number:016x}:{creation_filetime:016x}")
}

#[cfg(any(windows, test))]
fn parse_windows_process_birth_token(token: &str) -> Option<(u64, u64)> {
    let mut fields = token.strip_prefix("windows:")?.split(':');
    let parse = |value: &str| {
        if value.len() != 16
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return None;
        }
        u64::from_str_radix(value, 16).ok()
    };
    let identity = (parse(fields.next()?)?, parse(fields.next()?)?);
    if fields.next().is_some() {
        None
    } else {
        Some(identity)
    }
}

#[cfg(windows)]
fn windows_process_creation_filetime(
    handle: windows_sys::Win32::Foundation::HANDLE,
) -> Option<u64> {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::GetProcessTimes;
    let mut creation = unsafe { std::mem::zeroed::<FILETIME>() };
    let mut exit = unsafe { std::mem::zeroed::<FILETIME>() };
    let mut kernel = unsafe { std::mem::zeroed::<FILETIME>() };
    let mut user = unsafe { std::mem::zeroed::<FILETIME>() };
    if unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) } == 0 {
        return None;
    }
    Some(((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64)
}

#[cfg(windows)]
fn windows_process_sequence_number(handle: windows_sys::Win32::Foundation::HANDLE) -> Option<u64> {
    use std::ffi::c_void;
    #[link(name = "ntdll")]
    extern "system" {
        fn NtQueryInformationProcess(
            process_handle: windows_sys::Win32::Foundation::HANDLE,
            process_information_class: u32,
            process_information: *mut c_void,
            process_information_length: u32,
            return_length: *mut u32,
        ) -> i32;
    }
    // PROCESSINFOCLASS::ProcessSequenceNumber. Windows assigns this monotonic
    // kernel sequence at creation specifically so PID reuse is distinguishable.
    const PROCESS_SEQUENCE_NUMBER: u32 = 92;
    let mut sequence = 0u64;
    let status = unsafe {
        NtQueryInformationProcess(
            handle,
            PROCESS_SEQUENCE_NUMBER,
            (&mut sequence as *mut u64).cast(),
            std::mem::size_of::<u64>() as u32,
            std::ptr::null_mut(),
        )
    };
    (status >= 0 && sequence != 0).then_some(sequence)
}

/// Native restart authority. Termination opens one process handle and checks
/// the persisted generation through that handle before mutation, closing the
/// PID-reuse window and then closing the launcher's kill-on-close job.
#[cfg(windows)]
fn windows_process_generation_command(args: &[std::ffi::OsString]) -> Option<i32> {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_TERMINATE, SYNCHRONIZE,
    };
    let operation = args.first()?.to_str()?;
    let query = operation == "--process-generation-query-v1" && args.len() == 2;
    let terminate = operation == "--process-generation-terminate-v1" && args.len() == 4;
    if !query && !terminate {
        return None;
    }
    let Some(pid) = args
        .get(1)
        .and_then(|value| value.to_str())
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value > 0)
    else {
        return Some(64);
    };
    let access = PROCESS_QUERY_LIMITED_INFORMATION
        | if terminate {
            PROCESS_TERMINATE | SYNCHRONIZE
        } else {
            0
        };
    let process = unsafe { OpenProcess(access, 0, pid) };
    if process.is_null() {
        return Some(74);
    }
    let identity =
        windows_process_sequence_number(process).zip(windows_process_creation_filetime(process));
    let Some((sequence, creation)) = identity else {
        unsafe { CloseHandle(process) };
        return Some(74);
    };
    if query {
        println!("{}", windows_process_birth_token(sequence, creation));
        unsafe { CloseHandle(process) };
        return Some(0);
    }
    let expected = args
        .get(2)
        .and_then(|value| value.to_str())
        .and_then(parse_windows_process_birth_token);
    let timeout_ms = args
        .get(3)
        .and_then(|value| value.to_str())
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value > 0);
    if expected != Some((sequence, creation)) || timeout_ms.is_none() {
        unsafe { CloseHandle(process) };
        return Some(75);
    }
    if unsafe { TerminateProcess(process, 1) } == 0 {
        unsafe { CloseHandle(process) };
        return Some(74);
    }
    let wait = unsafe { WaitForSingleObject(process, timeout_ms.unwrap()) };
    unsafe { CloseHandle(process) };
    Some(if wait == WAIT_OBJECT_0 { 0 } else { 74 })
}

#[cfg(any(windows, test))]
fn windows_filesystem_has_retained_identity(filesystem: &str) -> bool {
    // The staged JS contract and BY_HANDLE_FILE_INFORMATION retain only the
    // legacy 64-bit file index. NTFS supplies a stable identity in that form;
    // ReFS requires FILE_ID_128 and must remain rejected until the complete
    // staging and native comparison contract carries all 128 bits.
    filesystem == "NTFS"
}

#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WindowsLaunchStage {
    WorkerPath,
    AncestorOpen,
    AncestorInformation,
    AncestorReparse,
    WorkerOpen,
    WorkerInformation,
    WorkerReparse,
    VolumeInformation,
    VolumeFilesystem,
    ExpectedObject,
    TestGate,
    JobCreate,
    JobConfigure,
    StandardHandle,
    DuplicateHandle,
    AttributeStorage,
    JobAttribute,
    HandleAttribute,
    CreateProcess,
    NamedWorkerOpen,
    NamedWorkerInformation,
    NamedWorkerIdentity,
    ResumeThread,
    WaitProcess,
    QueryExitCode,
}

#[cfg(any(windows, test))]
impl WindowsLaunchStage {
    fn as_str(self) -> &'static str {
        match self {
            Self::WorkerPath => "worker_path",
            Self::AncestorOpen => "ancestor_open",
            Self::AncestorInformation => "ancestor_information",
            Self::AncestorReparse => "ancestor_reparse",
            Self::WorkerOpen => "worker_open",
            Self::WorkerInformation => "worker_information",
            Self::WorkerReparse => "worker_reparse",
            Self::VolumeInformation => "volume_information",
            Self::VolumeFilesystem => "volume_filesystem",
            Self::ExpectedObject => "expected_object",
            Self::TestGate => "test_gate",
            Self::JobCreate => "job_create",
            Self::JobConfigure => "job_configure",
            Self::StandardHandle => "standard_handle",
            Self::DuplicateHandle => "duplicate_handle",
            Self::AttributeStorage => "attribute_storage",
            Self::JobAttribute => "job_attribute",
            Self::HandleAttribute => "handle_attribute",
            Self::CreateProcess => "create_process",
            Self::NamedWorkerOpen => "named_worker_open",
            Self::NamedWorkerInformation => "named_worker_information",
            Self::NamedWorkerIdentity => "named_worker_identity",
            Self::ResumeThread => "resume_thread",
            Self::WaitProcess => "wait_process",
            Self::QueryExitCode => "query_exit_code",
        }
    }
}

#[cfg(any(windows, test))]
fn windows_launch_failure_record(stage: WindowsLaunchStage, win32: Option<u32>) -> String {
    match win32 {
        Some(code) => format!(
            "OPENCODE_NATIVE_LAUNCHER_FAILURE_V1 stage={} win32={code}",
            stage.as_str()
        ),
        None => format!(
            "OPENCODE_NATIVE_LAUNCHER_FAILURE_V1 stage={}",
            stage.as_str()
        ),
    }
}

#[cfg(windows)]
fn windows_launch_fail(stage: WindowsLaunchStage, win32: Option<u32>) -> ! {
    eprintln!("{}", windows_launch_failure_record(stage, win32));
    std::process::exit(126)
}

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
    use windows_sys::Win32::Foundation::{
        CloseHandle, DuplicateHandle, GetLastError, DUPLICATE_SAME_ACCESS, GENERIC_READ,
        INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, GetVolumeInformationByHandleW,
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::Console::{
        GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };
    use windows_sys::Win32::System::JobObjects::{
        CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcess, GetExitCodeProcess,
        InitializeProcThreadAttributeList, ResumeThread, TerminateProcess,
        UpdateProcThreadAttribute, WaitForSingleObject, CREATE_NEW_PROCESS_GROUP, CREATE_SUSPENDED,
        EXTENDED_STARTUPINFO_PRESENT, INFINITE, PROCESS_INFORMATION,
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_JOB_LIST, STARTF_USESTDHANDLES,
        STARTUPINFOEXW,
    };
    let all_args = std::env::args_os().skip(1).collect::<Vec<_>>();
    if let Some(code) = windows_process_generation_command(&all_args) {
        std::process::exit(code)
    }
    let mut args = all_args.into_iter();
    let worker = match args.next() {
        Some(v) => v,
        None => std::process::exit(125),
    };
    let mut forwarded = args.collect::<Vec<_>>();
    if forwarded.is_empty() {
        std::process::exit(125)
    }
    if worker.to_string_lossy().contains('"')
        || forwarded
            .iter()
            .any(|value| value.to_string_lossy().contains('"'))
    {
        std::process::exit(125)
    }
    let expected_object = if forwarded.first().and_then(|value| value.to_str())
        == Some("--verified-opencode-host-v1")
    {
        if forwarded.len() < 5 {
            std::process::exit(125)
        }
        let parsed = forwarded[1..4]
            .iter()
            .map(|value| value.to_str().and_then(|text| text.parse::<u64>().ok()))
            .collect::<Vec<_>>();
        if parsed.iter().any(Option::is_none) {
            std::process::exit(125)
        }
        forwarded.drain(0..4);
        Some((parsed[0].unwrap(), parsed[1].unwrap(), parsed[2].unwrap()))
    } else {
        None
    };
    let worker_path = std::path::PathBuf::from(&worker);
    if !worker_path.is_absolute() {
        windows_launch_fail(WindowsLaunchStage::WorkerPath, None)
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
        if handle == INVALID_HANDLE_VALUE {
            windows_launch_fail(
                WindowsLaunchStage::AncestorOpen,
                Some(unsafe { GetLastError() }),
            )
        }
        if unsafe { GetFileInformationByHandle(handle, &mut information) } == 0 {
            let error = unsafe { GetLastError() };
            unsafe { CloseHandle(handle) };
            windows_launch_fail(WindowsLaunchStage::AncestorInformation, Some(error))
        }
        if information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            unsafe { CloseHandle(handle) };
            windows_launch_fail(WindowsLaunchStage::AncestorReparse, None)
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
        windows_launch_fail(
            WindowsLaunchStage::WorkerOpen,
            Some(unsafe { GetLastError() }),
        )
    }
    let mut before = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
    if unsafe { GetFileInformationByHandle(held, &mut before) } == 0 {
        windows_launch_fail(
            WindowsLaunchStage::WorkerInformation,
            Some(unsafe { GetLastError() }),
        )
    }
    if before.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        windows_launch_fail(WindowsLaunchStage::WorkerReparse, None)
    }
    let mut fs_name = [0u16; 32];
    let volume_result = unsafe {
        GetVolumeInformationByHandleW(
            held,
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            fs_name.as_mut_ptr(),
            fs_name.len() as u32,
        )
    };
    if volume_result == 0 {
        windows_launch_fail(
            WindowsLaunchStage::VolumeInformation,
            Some(unsafe { GetLastError() }),
        )
    }
    let fs_name_end = fs_name
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(fs_name.len());
    let filesystem = String::from_utf16_lossy(&fs_name[..fs_name_end]);
    if !windows_filesystem_has_retained_identity(&filesystem) {
        eprintln!("{WINDOWS_VOLUME_IDENTITY_UNVERIFIED}");
        windows_launch_fail(WindowsLaunchStage::VolumeFilesystem, None)
    }
    if let Some((expected_dev, expected_ino, expected_size)) = expected_object {
        let actual_ino = ((before.nFileIndexHigh as u64) << 32) | before.nFileIndexLow as u64;
        let actual_size = ((before.nFileSizeHigh as u64) << 32) | before.nFileSizeLow as u64;
        if before.dwVolumeSerialNumber as u64 != expected_dev
            || actual_ino != expected_ino
            || actual_size != expected_size
        {
            windows_launch_fail(WindowsLaunchStage::ExpectedObject, None)
        }
    }
    // Inputs containing quotes are rejected above. Doubling trailing
    // backslashes before the closing quote preserves the exact Windows argv.
    let quote = |value: &std::ffi::OsStr| {
        let text = value.to_string_lossy();
        let trailing = text.chars().rev().take_while(|c| *c == '\\').count();
        format!("\"{}{}\"", text, "\\".repeat(trailing))
    };
    let command = std::iter::once(worker.as_os_str())
        .chain(forwarded.iter().map(|value| value.as_os_str()))
        .map(quote)
        .collect::<Vec<_>>()
        .join(" ");
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
            windows_launch_fail(WindowsLaunchStage::TestGate, None)
        }
        while !release.exists() {
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }
    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() {
        windows_launch_fail(
            WindowsLaunchStage::JobCreate,
            Some(unsafe { GetLastError() }),
        )
    }
    let mut limits = unsafe { std::mem::zeroed::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const _,
            std::mem::size_of_val(&limits) as u32,
        )
    } == 0
    {
        windows_launch_fail(
            WindowsLaunchStage::JobConfigure,
            Some(unsafe { GetLastError() }),
        )
    }

    // The launcher is itself started with Bun protocol pipes. CreateProcessW
    // does not forward those standard handles unless they are explicitly
    // inheritable and selected in STARTUPINFO. Duplicate only the three
    // protocol handles and allowlist them so no unrelated inheritable launcher
    // handle crosses into the authority process.
    let current_process = unsafe { GetCurrentProcess() };
    let mut protocol_handles = [std::ptr::null_mut(); 3];
    for (index, standard) in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE]
        .into_iter()
        .enumerate()
    {
        let source = unsafe { GetStdHandle(standard) };
        if source.is_null() || source == INVALID_HANDLE_VALUE {
            windows_launch_fail(
                WindowsLaunchStage::StandardHandle,
                Some(unsafe { GetLastError() }),
            )
        }
        if unsafe {
            DuplicateHandle(
                current_process,
                source,
                current_process,
                &mut protocol_handles[index],
                0,
                1,
                DUPLICATE_SAME_ACCESS,
            )
        } == 0
        {
            windows_launch_fail(
                WindowsLaunchStage::DuplicateHandle,
                Some(unsafe { GetLastError() }),
            )
        }
    }

    let mut attribute_bytes = 0usize;
    unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 2, 0, &mut attribute_bytes) };
    let mut attribute_storage = vec![
        0usize;
        (attribute_bytes + std::mem::size_of::<usize>() - 1)
            / std::mem::size_of::<usize>()
    ];
    let attributes = attribute_storage.as_mut_ptr() as *mut _;
    if unsafe { InitializeProcThreadAttributeList(attributes, 2, 0, &mut attribute_bytes) } == 0 {
        windows_launch_fail(
            WindowsLaunchStage::AttributeStorage,
            Some(unsafe { GetLastError() }),
        )
    }
    if unsafe {
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
        windows_launch_fail(
            WindowsLaunchStage::JobAttribute,
            Some(unsafe { GetLastError() }),
        )
    }
    if unsafe {
        UpdateProcThreadAttribute(
            attributes,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            protocol_handles.as_mut_ptr().cast(),
            std::mem::size_of_val(&protocol_handles),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    } == 0
    {
        windows_launch_fail(
            WindowsLaunchStage::HandleAttribute,
            Some(unsafe { GetLastError() }),
        )
    }
    let mut startup = unsafe { std::mem::zeroed::<STARTUPINFOEXW>() };
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = protocol_handles[0];
    startup.StartupInfo.hStdOutput = protocol_handles[1];
    startup.StartupInfo.hStdError = protocol_handles[2];
    startup.lpAttributeList = attributes;
    let mut process = unsafe { std::mem::zeroed::<PROCESS_INFORMATION>() };
    let created = unsafe {
        CreateProcessW(
            worker_w.as_mut_ptr(),
            command_w.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
            CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP | EXTENDED_STARTUPINFO_PRESENT,
            std::ptr::null(),
            std::ptr::null(),
            &startup.StartupInfo,
            &mut process,
        )
    };
    let create_error = if created == 0 {
        Some(unsafe { GetLastError() })
    } else {
        None
    };
    unsafe { DeleteProcThreadAttributeList(attributes) };
    for handle in protocol_handles {
        unsafe { CloseHandle(handle) };
    }
    if let Some(error) = create_error {
        windows_launch_fail(WindowsLaunchStage::CreateProcess, Some(error))
    }
    // CreateProcess consumed a pathname. While the retained no-share-write /
    // no-share-delete handles make replacement fail, compare the named object
    // again before allowing the suspended child to execute so this invariant
    // remains explicit and fail-closed on every supported Windows filesystem.
    let named_after = unsafe {
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
    let mut after = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
    if named_after == INVALID_HANDLE_VALUE {
        let error = unsafe { GetLastError() };
        unsafe { TerminateProcess(process.hProcess, 126) };
        windows_launch_fail(WindowsLaunchStage::NamedWorkerOpen, Some(error))
    }
    if unsafe { GetFileInformationByHandle(named_after, &mut after) } == 0 {
        let error = unsafe { GetLastError() };
        unsafe { TerminateProcess(process.hProcess, 126) };
        windows_launch_fail(WindowsLaunchStage::NamedWorkerInformation, Some(error))
    }
    let same_object = after.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT == 0
        && before.dwVolumeSerialNumber == after.dwVolumeSerialNumber
        && before.nFileIndexHigh == after.nFileIndexHigh
        && before.nFileIndexLow == after.nFileIndexLow;
    if named_after != INVALID_HANDLE_VALUE {
        unsafe { CloseHandle(named_after) };
    }
    if !same_object {
        unsafe {
            TerminateProcess(process.hProcess, 126);
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
            CloseHandle(job);
            CloseHandle(held);
        }
        windows_launch_fail(WindowsLaunchStage::NamedWorkerIdentity, None)
    }
    // PROC_THREAD_ATTRIBUTE_JOB_LIST attached the kill-on-close job as part of
    // creation itself. No uncontained suspended-child interval exists.
    if unsafe { ResumeThread(process.hThread) } == u32::MAX {
        let error = unsafe { GetLastError() };
        unsafe {
            TerminateProcess(process.hProcess, 126);
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
            CloseHandle(job);
            CloseHandle(held);
        }
        windows_launch_fail(WindowsLaunchStage::ResumeThread, Some(error))
    }
    unsafe { CloseHandle(process.hThread) };
    let wait = unsafe { WaitForSingleObject(process.hProcess, INFINITE) };
    if wait != WAIT_OBJECT_0 {
        windows_launch_fail(
            WindowsLaunchStage::WaitProcess,
            Some(unsafe { GetLastError() }),
        )
    }
    let mut code = 126u32;
    if unsafe { GetExitCodeProcess(process.hProcess, &mut code) } == 0 {
        windows_launch_fail(
            WindowsLaunchStage::QueryExitCode,
            Some(unsafe { GetLastError() }),
        )
    }
    unsafe {
        CloseHandle(process.hProcess);
        CloseHandle(job);
        CloseHandle(held)
    };
    for handle in ancestor_handles {
        unsafe { CloseHandle(handle) };
    }
    std::process::exit(code as i32)
}

#[cfg(test)]
mod tests {
    use super::{
        parse_windows_process_birth_token, windows_filesystem_has_retained_identity,
        windows_launch_failure_record, windows_process_birth_token, WindowsLaunchStage,
    };

    #[test]
    fn windows_process_generation_tokens_preserve_all_native_filetime_bits() {
        assert_eq!(
            windows_process_birth_token(0x0123, 0x01d9_abcd_0000_0042),
            "windows:0000000000000123:01d9abcd00000042"
        );
        assert_eq!(
            parse_windows_process_birth_token("windows:0000000000000123:01d9abcd00000042"),
            Some((0x0123, 0x01d9_abcd_0000_0042))
        );
        for malformed in [
            "",
            "windows:1",
            "windows:0000000000000123:01D9ABCD00000042",
            "linux:0000000000000123:01d9abcd00000042",
            "windows:0000000000000123:01d9abcd0000004g",
            "windows:0000000000000123:01d9abcd000000420",
        ] {
            assert_eq!(parse_windows_process_birth_token(malformed), None);
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_runtime_reads_current_native_process_generation() {
        let handle = unsafe { windows_sys::Win32::System::Threading::GetCurrentProcess() };
        let sequence = super::windows_process_sequence_number(handle)
            .expect("current process sequence number");
        let creation = super::windows_process_creation_filetime(handle)
            .expect("current process creation FILETIME");
        assert_ne!(sequence, 0);
        assert_ne!(creation, 0);
        let token = windows_process_birth_token(sequence, creation);
        assert_eq!(
            parse_windows_process_birth_token(&token),
            Some((sequence, creation))
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_runtime_atomically_terminates_only_the_exact_fixture_generation() {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::windows_process_generation_termination_fixture",
                "--nocapture",
            ])
            .env("OPENCODE_PROCESS_GENERATION_FIXTURE", "1")
            .spawn()
            .expect("spawn native process-generation fixture");
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, child.id()) };
        let identity = if process.is_null() {
            None
        } else {
            let observed = super::windows_process_sequence_number(process)
                .zip(super::windows_process_creation_filetime(process));
            unsafe { CloseHandle(process) };
            observed
        };
        let Some((sequence, creation)) = identity else {
            let _ = child.kill();
            let _ = child.wait();
            panic!("query native process-generation fixture");
        };
        let mismatched = windows_process_birth_token(sequence.wrapping_add(1), creation);
        let mismatch_args = [
            "--process-generation-terminate-v1".into(),
            child.id().to_string().into(),
            mismatched.into(),
            "5000".into(),
        ];
        let mismatch_result = super::windows_process_generation_command(&mismatch_args);
        if mismatch_result != Some(75) {
            let _ = child.kill();
            let _ = child.wait();
        }
        assert_eq!(mismatch_result, Some(75));
        assert!(child.try_wait().unwrap().is_none());
        let token = windows_process_birth_token(sequence, creation);
        let args = [
            "--process-generation-terminate-v1".into(),
            child.id().to_string().into(),
            token.into(),
            "5000".into(),
        ];
        let result = super::windows_process_generation_command(&args);
        if result != Some(0) {
            let _ = child.kill();
        }
        let status = child
            .wait()
            .expect("reap native process-generation fixture");
        assert_eq!(result, Some(0));
        assert!(!status.success());
    }

    #[cfg(windows)]
    #[test]
    fn windows_process_generation_termination_fixture() {
        if std::env::var_os("OPENCODE_PROCESS_GENERATION_FIXTURE").is_some() {
            std::thread::sleep(std::time::Duration::from_secs(30));
        }
    }

    #[test]
    fn retained_windows_identity_accepts_ntfs() {
        assert!(windows_filesystem_has_retained_identity("NTFS"));
    }

    #[test]
    fn retained_windows_identity_rejects_refs_and_other_filesystems() {
        for filesystem in ["ReFS", "refs", "FAT32", "exFAT", ""] {
            assert!(!windows_filesystem_has_retained_identity(filesystem));
        }
    }

    #[test]
    fn windows_failure_records_are_stable_bounded_and_path_free() {
        let record = windows_launch_failure_record(WindowsLaunchStage::CreateProcess, Some(87));
        assert_eq!(
            record,
            "OPENCODE_NATIVE_LAUNCHER_FAILURE_V1 stage=create_process win32=87"
        );
        assert!(record.len() < 128);
        assert!(!record.contains('\\'));
        assert!(!record.contains('/'));

        let stages = [
            WindowsLaunchStage::WorkerPath,
            WindowsLaunchStage::AncestorOpen,
            WindowsLaunchStage::AncestorInformation,
            WindowsLaunchStage::AncestorReparse,
            WindowsLaunchStage::WorkerOpen,
            WindowsLaunchStage::WorkerInformation,
            WindowsLaunchStage::WorkerReparse,
            WindowsLaunchStage::VolumeInformation,
            WindowsLaunchStage::VolumeFilesystem,
            WindowsLaunchStage::ExpectedObject,
            WindowsLaunchStage::TestGate,
            WindowsLaunchStage::JobCreate,
            WindowsLaunchStage::JobConfigure,
            WindowsLaunchStage::StandardHandle,
            WindowsLaunchStage::DuplicateHandle,
            WindowsLaunchStage::AttributeStorage,
            WindowsLaunchStage::JobAttribute,
            WindowsLaunchStage::HandleAttribute,
            WindowsLaunchStage::CreateProcess,
            WindowsLaunchStage::NamedWorkerOpen,
            WindowsLaunchStage::NamedWorkerInformation,
            WindowsLaunchStage::NamedWorkerIdentity,
            WindowsLaunchStage::ResumeThread,
            WindowsLaunchStage::WaitProcess,
            WindowsLaunchStage::QueryExitCode,
        ];
        let names = stages.map(WindowsLaunchStage::as_str);
        let unique = names.into_iter().collect::<std::collections::HashSet<_>>();
        assert_eq!(unique.len(), stages.len());
        assert!(names.into_iter().all(|name| name.len() <= 32
            && name
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte == b'_')));
    }
}
