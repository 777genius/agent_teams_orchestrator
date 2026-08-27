use std::env;
use std::fs::{create_dir_all, OpenOptions};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{self, Command, Stdio};
use std::thread;
use std::time::Duration;

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

fn main() {
    if env::args().any(|arg| arg == "--static-grandchild") {
        record_pid("grandchild");
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
    let _grandchild = Command::new(executable)
        .arg("--static-grandchild")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn static grandchild");
    let listener = TcpListener::bind(("127.0.0.1", port)).expect("bind fixture loopback");
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { continue };
        let mut request = [0_u8; 4096];
        let _ = stream.read(&mut request);
        let body = if request.starts_with(b"GET /global/health ") {
            r#"{"healthy":true,"version":"static-fixture"}"#
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
