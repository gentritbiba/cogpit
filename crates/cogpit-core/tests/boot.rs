//! Runs the real binary the way the TS supervisor does: boot line on stdin,
//! handshake on stdout, requests over loopback, exit when stdin closes.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::{Duration, Instant};

use core_protocol::{Handshake, PROTOCOL_VERSION, SECRET_HEADER};

const SECRET: &str = "test-secret-0123456789";

struct Core {
    child: Child,
    stdin: Option<ChildStdin>,
    port: u16,
}

impl Core {
    fn boot() -> (Self, Handshake) {
        let mut child = Command::new(env!("CARGO_BIN_EXE_cogpit-core"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn cogpit-core");
        let mut stdin = child.stdin.take().unwrap();
        writeln!(
            stdin,
            r#"{{"secret":"{SECRET}","config":{{"dataDir":"{}"}}}}"#,
            std::env::temp_dir()
                .display()
                .to_string()
                .replace('\\', "\\\\")
        )
        .unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let handshake: Handshake = serde_json::from_str(&line).expect("handshake line");
        let core = Core {
            child,
            stdin: Some(stdin),
            port: handshake.port,
        };
        (core, handshake)
    }

    fn get(&self, path: &str, secret: Option<&str>) -> (u16, String) {
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).unwrap();
        let secret_line = secret.map_or(String::new(), |s| format!("{SECRET_HEADER}: {s}\r\n"));
        write!(
            stream,
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n{secret_line}Connection: close\r\n\r\n"
        )
        .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        let status = response[9..12].parse().unwrap();
        let body = response
            .split_once("\r\n\r\n")
            .map(|(_, b)| b.to_owned())
            .unwrap();
        (status, body)
    }

    fn wait_for_exit(&mut self, limit: Duration) -> bool {
        let started = Instant::now();
        while started.elapsed() < limit {
            if self.child.try_wait().unwrap().is_some() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }
}

impl Drop for Core {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn prints_a_handshake_with_its_loopback_port() {
    let (core, handshake) = Core::boot();
    assert_ne!(handshake.port, 0);
    assert_eq!(handshake.version, env!("CARGO_PKG_VERSION"));
    assert_eq!(handshake.protocol, PROTOCOL_VERSION);
    let (status, body) = core.get("/v1/health", Some(SECRET));
    assert_eq!(status, 200);
    assert!(body.contains(r#""status":"ok""#), "{body}");
}

#[test]
fn rejects_requests_without_the_secret() {
    let (core, _) = Core::boot();
    assert_eq!(core.get("/v1/health", None).0, 401);
    assert_eq!(core.get("/v1/health", Some("wrong")).0, 401);
    assert_eq!(core.get("/v1/nothing-here", None).0, 401);
    assert_eq!(core.get("/v1/nothing-here", Some(SECRET)).0, 404);
}

#[test]
fn exits_when_stdin_closes() {
    let (mut core, _) = Core::boot();
    assert_eq!(core.get("/v1/health", Some(SECRET)).0, 200);
    drop(core.stdin.take());
    assert!(
        core.wait_for_exit(Duration::from_secs(5)),
        "core kept running after stdin closed"
    );
    assert!(core.child.try_wait().unwrap().unwrap().success());
}

#[test]
fn refuses_to_start_without_a_boot_message() {
    let output = Command::new(env!("CARGO_BIN_EXE_cogpit-core"))
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("boot message"));
}
