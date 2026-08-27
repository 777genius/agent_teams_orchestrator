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

fn main() {
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
