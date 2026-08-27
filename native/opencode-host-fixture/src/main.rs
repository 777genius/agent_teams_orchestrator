use std::env;
use std::fs::{create_dir_all, OpenOptions};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{self, Command, Stdio};
use std::thread;
use std::time::Duration;

#[cfg(unix)]
fn ignore_termination() {
    extern "C" {
        fn signal(signal: i32, handler: usize) -> usize;
    }
    const SIGTERM: i32 = 15;
    const SIG_IGN: usize = 1;
    unsafe {
        signal(SIGTERM, SIG_IGN);
    }
}

#[cfg(not(unix))]
fn ignore_termination() {}

fn record_pid(role: &str) {
    let Some(root) = env::var_os("CLAUDE_MULTIMODEL_DATA_HOME") else {
        return;
    };
    let root = PathBuf::from(root);
    let _ = create_dir_all(&root);
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("static-host-fixture.pids"))
    {
        let _ = writeln!(file, "{}:{}", role, process::id());
        let _ = file.sync_all();
    }
}

fn fixture_mode() -> String {
    env::var_os("CLAUDE_MULTIMODEL_DATA_HOME")
        .and_then(|root| {
            std::fs::read_to_string(PathBuf::from(root).join("static-host-fixture.mode")).ok()
        })
        .unwrap_or_default()
        .trim()
        .to_owned()
}

fn fixture_state_path(name: &str) -> Option<PathBuf> {
    env::var_os("CLAUDE_MULTIMODEL_DATA_HOME").map(|root| PathBuf::from(root).join(name))
}

#[cfg(target_os = "linux")]
mod pid_namespace_supervisor {
    use super::*;
    use std::ffi::CString;
    use std::io::{ErrorKind, Read, Write};
    use std::os::unix::net::UnixListener;
    use std::os::unix::process::CommandExt;
    use std::time::{SystemTime, UNIX_EPOCH};

    const SIGCONT: i32 = 18;
    const SIGSTOP: i32 = 19;
    const WUNTRACED: i32 = 2;
    const RECYCLE_REQUEST_HEADER_LEN: usize = 16;
    const MAX_DATA_HOME_LEN: usize = 4096;

    extern "C" {
        fn execv(path: *const i8, argv: *const *const i8) -> i32;
        fn fork() -> i32;
        fn kill(pid: i32, signal: i32) -> i32;
        fn setpgid(pid: i32, pgid: i32) -> i32;
        fn waitpid(pid: i32, status: *mut i32, options: i32) -> i32;
    }

    fn process_group_signal(pgid: u32, signal: i32) -> Result<(), String> {
        let result = unsafe { kill(-(pgid as i32), signal) };
        if result == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error().to_string())
        }
    }

    fn stop_process_group(pgid: u32) -> Result<(), String> {
        process_group_signal(pgid, SIGSTOP)?;
        let mut status = 0;
        let waited = unsafe { waitpid(pgid as i32, &mut status, WUNTRACED) };
        if waited != pgid as i32 || status & 0xff != 0x7f {
            let _ = process_group_signal(pgid, SIGCONT);
            return Err(format!(
                "Bun process-group leader {pgid} did not enter a stopped state: waitpid={waited}, status={status}"
            ));
        }
        Ok(())
    }

    fn reap_exact(pid: u32) -> Result<(), String> {
        let mut status = 0;
        let waited = unsafe { waitpid(pid as i32, &mut status, 0) };
        if waited != pid as i32 {
            return Err(format!(
                "waitpid({pid}) returned {waited}: {}",
                std::io::Error::last_os_error()
            ));
        }
        let proc_path = PathBuf::from(format!("/proc/{pid}"));
        if proc_path.exists() {
            return Err(format!("{proc_path:?} remains after exact waitpid"));
        }
        Ok(())
    }

    fn read_recycle_request(
        stream: &mut std::os::unix::net::UnixStream,
    ) -> Result<Vec<u8>, String> {
        let mut header = [0_u8; RECYCLE_REQUEST_HEADER_LEN];
        stream
            .read_exact(&mut header)
            .map_err(|error| format!("read recycle request header: {error}"))?;
        if &header[..4] != b"OPCR" {
            return Err("invalid recycle request magic".to_owned());
        }
        let data_home_len = u32::from_be_bytes(header[12..16].try_into().unwrap()) as usize;
        if data_home_len == 0 || data_home_len > MAX_DATA_HOME_LEN {
            return Err(format!(
                "invalid fixture data-home length {data_home_len}; maximum is {MAX_DATA_HOME_LEN}"
            ));
        }

        let mut request = Vec::with_capacity(RECYCLE_REQUEST_HEADER_LEN + data_home_len);
        request.extend_from_slice(&header);
        request.resize(RECYCLE_REQUEST_HEADER_LEN + data_home_len, 0);
        stream
            .read_exact(&mut request[RECYCLE_REQUEST_HEADER_LEN..])
            .map_err(|error| format!("read recycle request payload: {error}"))?;

        // The protocol admits exactly one length-prefixed request. Do not wait
        // for EOF: Bun intentionally keeps its read side open for the reply.
        stream
            .set_nonblocking(true)
            .map_err(|error| format!("inspect recycle request boundary: {error}"))?;
        let mut trailing = [0_u8; 1];
        let boundary = match stream.read(&mut trailing) {
            Ok(0) => Ok(()),
            Ok(_) => Err("trailing bytes after recycle request payload".to_owned()),
            Err(error) if error.kind() == ErrorKind::WouldBlock => Ok(()),
            Err(error) => Err(format!("inspect recycle request boundary: {error}")),
        };
        let restored = stream
            .set_nonblocking(false)
            .map_err(|error| format!("restore recycle response socket: {error}"));
        boundary?;
        restored?;
        Ok(request)
    }

    fn recycle_once(request: &[u8], bun_pgid: u32) -> Result<u32, String> {
        if request.len() < RECYCLE_REQUEST_HEADER_LEN || &request[..4] != b"OPCR" {
            return Err("invalid recycle request".to_owned());
        }
        let leader = u32::from_be_bytes(request[4..8].try_into().unwrap());
        let grandchild = u32::from_be_bytes(request[8..12].try_into().unwrap());
        let data_home_len = u32::from_be_bytes(request[12..16].try_into().unwrap()) as usize;
        if data_home_len == 0
            || data_home_len > MAX_DATA_HOME_LEN
            || request.len() != RECYCLE_REQUEST_HEADER_LEN + data_home_len
        {
            return Err("invalid recycle request length".to_owned());
        }
        if leader <= 1 || grandchild <= 1 || leader == grandchild {
            return Err("invalid receipt-bound process ids".to_owned());
        }
        let data_home = std::str::from_utf8(&request[RECYCLE_REQUEST_HEADER_LEN..])
            .map_err(|error| error.to_string())?;
        if data_home.is_empty() || data_home.as_bytes().contains(&0) {
            return Err("invalid fixture data home".to_owned());
        }

        // These exact processes have been adopted by namespace PID 1. Waiting
        // for them here frees both slots; merely observing Z/X as dead does not.
        reap_exact(leader)?;
        reap_exact(grandchild)?;

        stop_process_group(bun_pgid)?;
        let result = (|| {
            std::fs::write("/proc/sys/kernel/ns_last_pid", (leader - 1).to_string())
                .map_err(|error| error.to_string())?;
            env::set_var("CLAUDE_MULTIMODEL_DATA_HOME", data_home);
            let executable = env::current_exe().map_err(|error| error.to_string())?;
            let executable = CString::new(executable.as_os_str().as_encoded_bytes())
                .map_err(|error| error.to_string())?;
            let argument = CString::new("--static-recycled-leader").unwrap();
            let child = unsafe { fork() };
            if child < 0 {
                return Err(format!("fork failed: {}", std::io::Error::last_os_error()));
            }
            if child == 0 {
                unsafe {
                    if setpgid(0, 0) != 0 {
                        process::exit(126);
                    }
                    let argv = [executable.as_ptr(), argument.as_ptr(), std::ptr::null()];
                    execv(executable.as_ptr(), argv.as_ptr());
                    process::exit(127);
                }
            }
            if child as u32 != leader {
                unsafe {
                    kill(child, 9);
                }
                return Err(format!(
                    "single recycled fork produced PID {child}, expected {leader}"
                ));
            }
            Ok(child as u32)
        })();
        let resumed = process_group_signal(bun_pgid, SIGCONT);
        result.and(resumed.map(|_| leader))
    }

    pub fn run(command: Vec<String>) -> i32 {
        if process::id() != 1 {
            eprintln!("pid namespace supervisor must run as PID 1");
            return 125;
        }
        if command.is_empty() {
            eprintln!("pid namespace supervisor requires a command");
            return 125;
        }
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let socket_path = env::temp_dir().join(format!("opencode-pid-supervisor-{nonce}.sock"));
        let listener = UnixListener::bind(&socket_path).expect("bind pid supervisor socket");
        listener
            .set_nonblocking(true)
            .expect("set pid supervisor socket nonblocking");

        let mut bun = Command::new(&command[0]);
        bun.args(&command[1..])
            .env("OPENCODE_PID_NAMESPACE_SUPERVISOR_SOCKET", &socket_path)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        unsafe {
            bun.pre_exec(|| {
                if setpgid(0, 0) == 0 {
                    Ok(())
                } else {
                    Err(std::io::Error::last_os_error())
                }
            });
        }
        let mut bun = bun.spawn().expect("start supervised Bun process group");
        let bun_pgid = bun.id();
        let mut coordinated = false;

        let exit_code = loop {
            if !coordinated {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let response = match read_recycle_request(&mut stream) {
                            Ok(request) => recycle_once(&request, bun_pgid)
                                .map(|pid| format!("OK {pid}\n"))
                                .unwrap_or_else(|error| format!("ERR {error}\n")),
                            Err(error) => format!("ERR {error}\n"),
                        };
                        let _ = stream.write_all(response.as_bytes());
                        coordinated = true;
                    }
                    Err(error) if error.kind() == ErrorKind::WouldBlock => {}
                    Err(error) => panic!("accept pid supervisor command: {error}"),
                }
            }
            match bun.try_wait() {
                Ok(Some(status)) => break status.code().unwrap_or(1),
                Ok(None) => thread::sleep(Duration::from_millis(5)),
                Err(error) => panic!("wait for supervised Bun: {error}"),
            }
        };
        let _ = std::fs::remove_file(socket_path);
        exit_code
    }
}

fn main() {
    #[cfg(target_os = "linux")]
    if let Some(position) = env::args().position(|arg| arg == "--pid-namespace-supervisor") {
        let command = env::args().skip(position + 1).collect();
        process::exit(pid_namespace_supervisor::run(command));
    }
    if env::current_exe()
        .ok()
        .and_then(|path| path.file_name().map(|name| name.to_ascii_lowercase()))
        .is_some_and(|name| name == "taskkill.exe")
    {
        record_pid("taskkill-mutation");
        process::exit(97);
    }
    if env::args().any(|arg| arg == "--static-recycled-leader") {
        record_pid("recycled-leader");
        let executable = env::current_exe().expect("fixture executable");
        let _follower = Command::new(executable)
            .arg("--static-recycled-follower")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn static recycled follower");
        ignore_termination();
        loop {
            thread::sleep(Duration::from_secs(60));
        }
    }
    if env::args().any(|arg| arg == "--static-recycled-follower") {
        record_pid("recycled-follower");
        loop {
            thread::sleep(Duration::from_secs(60));
        }
    }
    if env::args().any(|arg| arg == "--static-grandchild") {
        record_pid("grandchild");
        if fixture_mode() == "leader-exit" {
            ignore_termination();
            if let Some(ready) = fixture_state_path("static-host-fixture.grandchild-ready") {
                let _ = std::fs::write(ready, b"ready\n");
            }
        }
        loop {
            thread::sleep(Duration::from_secs(60));
        }
    }
    let args: Vec<String> = env::args().collect();
    let port = args
        .windows(2)
        .find(|pair| pair[0] == "--port")
        .and_then(|pair| pair[1].parse::<u16>().ok())
        .expect("fixture requires --port");
    record_pid("child");
    let executable = env::current_exe().expect("fixture executable");
    let mode = fixture_mode();
    let ready_path = fixture_state_path("static-host-fixture.grandchild-ready");
    if mode == "leader-exit" {
        if let Some(ready) = &ready_path {
            let _ = std::fs::remove_file(ready);
        }
    }
    let _grandchild = Command::new(executable)
        .arg("--static-grandchild")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn static grandchild");
    if mode == "leader-exit" {
        for _ in 0..200 {
            if ready_path.as_ref().is_some_and(|ready| ready.exists()) {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        // Give the real HostManager a deterministic window to capture the
        // leader's native birth token before exercising leader-loss replay.
        // The listener is intentionally not bound, so health cannot succeed.
        thread::sleep(Duration::from_millis(250));
        process::exit(72);
    }
    let listener = TcpListener::bind(("127.0.0.1", port)).expect("bind fixture loopback");
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { continue };
        let mut request = [0_u8; 4096];
        let _ = stream.read(&mut request);
        let body = if request.starts_with(b"GET /global/health ") {
            if fixture_mode() == "unhealthy" {
                r#"{"healthy":false,"version":"static-fixture"}"#
            } else {
                r#"{"healthy":true,"version":"static-fixture"}"#
            }
        } else {
            r#"{"ok":true}"#
        };
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(), body,
        );
        let _ = stream.write_all(response.as_bytes());
        let _ = stream.flush();
    }
}
