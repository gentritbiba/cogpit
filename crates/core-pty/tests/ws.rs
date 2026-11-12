//! The terminal panel's protocol, end to end: a real server, real WebSocket
//! clients and real processes on a real PTY.

use std::net::SocketAddr;
use std::time::Duration;

use core_pty::{PtyState, router};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

const WAIT: Duration = Duration::from_secs(20);

async fn start() -> SocketAddr {
    start_with(PtyState::new()).await
}

async fn start_with(state: PtyState) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = router(state);
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    addr
}

struct Client {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
}

impl Client {
    async fn connect(addr: SocketAddr) -> Self {
        let (socket, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws"))
            .await
            .unwrap();
        Self { socket }
    }

    async fn send(&mut self, message: Value) {
        self.socket
            .send(Message::text(message.to_string()))
            .await
            .unwrap();
    }

    async fn send_raw(&mut self, text: &str) {
        self.socket.send(Message::text(text)).await.unwrap();
    }

    async fn next(&mut self) -> Value {
        loop {
            let frame = tokio::time::timeout(WAIT, self.socket.next())
                .await
                .expect("timed out waiting for a frame")
                .expect("socket closed")
                .unwrap();
            if let Message::Text(text) = frame {
                return serde_json::from_str(&text).unwrap();
            }
        }
    }

    /// Skips frames until one matches.
    async fn until(&mut self, matches: impl Fn(&Value) -> bool) -> Value {
        loop {
            let frame = self.next().await;
            if matches(&frame) {
                return frame;
            }
        }
    }

    async fn frame(&mut self, kind: &str, id: &str) -> Value {
        self.until(|f| f["type"] == kind && f["id"] == id).await
    }

    /// Collects a session's output until it contains `needle`.
    async fn output_until(&mut self, id: &str, needle: &str) -> String {
        let mut seen = String::new();
        while !seen.contains(needle) {
            let frame = self.frame("output", id).await;
            seen.push_str(frame["data"].as_str().unwrap());
        }
        seen
    }

    async fn sessions_where(&mut self, matches: impl Fn(&[Value]) -> bool) -> Vec<Value> {
        let frame = self
            .until(|f| f["type"] == "sessions" && matches(f["sessions"].as_array().unwrap()))
            .await;
        frame["sessions"].as_array().unwrap().clone()
    }
}

fn find<'a>(sessions: &'a [Value], id: &str) -> Option<&'a Value> {
    sessions.iter().find(|s| s["id"] == id)
}

/// Prints `text` and exits with `code`, without an interactive shell.
fn print_and_exit(id: &str, text: &str, code: i32) -> Value {
    if cfg!(windows) {
        json!({ "type": "spawn", "id": id, "command": "cmd.exe",
                "args": format!("/d /s /c \"echo {text}& exit {code}\"") })
    } else {
        json!({ "type": "spawn", "id": id, "command": "/bin/sh",
                "args": ["-c", format!("printf '%s\\n' {text}; exit {code}")] })
    }
}

fn shell(id: &str) -> Value {
    if cfg!(windows) {
        json!({ "type": "spawn", "id": id, "command": "cmd.exe", "args": ["/d"] })
    } else {
        json!({ "type": "spawn", "id": id, "command": "/bin/sh" })
    }
}

/// A line whose output (`42`) differs from its echo.
fn answer_line() -> &'static str {
    if cfg!(windows) {
        "set /a 6*7\r\n"
    } else {
        "echo $((6*7))\n"
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn runs_a_process_and_replays_it_to_a_late_client() {
    let addr = start().await;
    let mut first = Client::connect(addr).await;
    let mut spawn = print_and_exit("job", "hello-pty", 3);
    spawn["name"] = json!("Build");
    spawn["metadata"] = json!({ "type": "script", "source": "root/", "scriptName": "build" });
    first.send(spawn).await;

    assert_eq!(
        first.next().await,
        json!({ "type": "spawned", "id": "job", "name": "Build" })
    );
    let sessions = first.sessions_where(|s| find(s, "job").is_some()).await;
    let session = find(&sessions, "job").unwrap();
    assert_eq!(session["status"], "running");
    assert_eq!(session["exitCode"], Value::Null);
    assert_eq!(session["metadata"]["scriptName"], "build");
    assert!(session["createdAt"].as_u64().unwrap() > 0);

    first.output_until("job", "hello-pty").await;
    assert_eq!(first.frame("exit", "job").await["code"], 3);
    let sessions = first
        .sessions_where(|s| find(s, "job").is_some_and(|j| j["status"] == "exited"))
        .await;
    assert_eq!(find(&sessions, "job").unwrap()["exitCode"], 3);

    let mut late = Client::connect(addr).await;
    late.send(json!({ "type": "attach", "id": "job" })).await;
    let replay = late.next().await;
    assert_eq!(replay["type"], "output");
    assert!(replay["data"].as_str().unwrap().contains("hello-pty"));
    assert_eq!(
        late.next().await,
        json!({ "type": "exit", "id": "job", "code": 3 })
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn sends_output_to_every_attached_client_and_kills_on_request() {
    let addr = start().await;
    let mut owner = Client::connect(addr).await;
    let mut viewer = Client::connect(addr).await;
    owner.send(shell("sh")).await;
    owner.frame("spawned", "sh").await;
    viewer.send(json!({ "type": "attach", "id": "sh" })).await;
    viewer.send(json!({ "type": "list" })).await;
    viewer.sessions_where(|s| find(s, "sh").is_some()).await;

    owner
        .send(json!({ "type": "input", "id": "sh", "data": answer_line() }))
        .await;
    owner.output_until("sh", "42").await;
    viewer.output_until("sh", "42").await;

    owner.send(json!({ "type": "kill", "id": "sh" })).await;
    owner.sessions_where(|s| find(s, "sh").is_none()).await;
    viewer.sessions_where(|s| find(s, "sh").is_none()).await;
    // A killed session still tells its watchers how it ended.
    viewer.frame("exit", "sh").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn renames_and_names_sessions_for_every_client() {
    let addr = start().await;
    let mut owner = Client::connect(addr).await;
    let mut other = Client::connect(addr).await;
    let mut unnamed = shell("one");
    unnamed["name"] = json!("");
    owner.send(unnamed).await;
    assert_eq!(owner.frame("spawned", "one").await["name"], "Terminal 1");
    other.sessions_where(|s| find(s, "one").is_some()).await;

    owner
        .send(json!({ "type": "rename", "id": "one", "name": "Logs" }))
        .await;
    other
        .sessions_where(|s| find(s, "one").is_some_and(|o| o["name"] == "Logs"))
        .await;
    owner.send(json!({ "type": "kill", "id": "one" })).await;
    other.sessions_where(|s| s.is_empty()).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_bad_requests_the_way_the_panel_expects() {
    let addr = start().await;
    let mut client = Client::connect(addr).await;

    client.send_raw("{not json").await;
    assert_eq!(
        client.next().await,
        json!({ "type": "error", "id": "", "message": "Invalid JSON" })
    );

    client
        .send(json!({ "type": "attach", "id": "missing" }))
        .await;
    assert_eq!(
        client.next().await,
        json!({ "type": "error", "id": "missing", "message": "Session not found" })
    );

    client
        .send(json!({ "type": "spawn", "id": "bad", "command": "cogpit-no-such-program" }))
        .await;
    let error = client.next().await;
    assert_eq!(error["type"], "error");
    assert_eq!(error["id"], "bad");
    assert!(
        error["message"]
            .as_str()
            .unwrap()
            .starts_with("Failed to spawn PTY: ")
    );

    // A folder that is gone fails the spawn rather than starting somewhere else.
    let gone = std::env::temp_dir().join("cogpit-pty-no-such-folder");
    let mut spawn = shell("nowhere");
    spawn["cwd"] = json!(gone.display().to_string());
    client.send(spawn).await;
    assert_eq!(
        client.next().await,
        json!({ "type": "error", "id": "nowhere",
                "message": format!("Failed to spawn PTY: the working directory {} is not a folder", gone.display()) })
    );

    client.send(shell("dup")).await;
    client.frame("spawned", "dup").await;
    client.send(shell("dup")).await;
    assert_eq!(
        client.frame("error", "dup").await["message"],
        "Session ID already exists"
    );
    client.send(json!({ "type": "kill", "id": "dup" })).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn gives_a_spawn_without_an_id_a_fresh_one() {
    let addr = start().await;
    let mut client = Client::connect(addr).await;
    let mut spawn = shell("");
    spawn.as_object_mut().unwrap().remove("id");
    client.send(spawn).await;
    let spawned = client.until(|f| f["type"] == "spawned").await;
    let id = spawned["id"].as_str().unwrap().to_owned();
    assert_eq!(id.len(), 36);
    client.send(json!({ "type": "kill", "id": id })).await;
}

/// Resizes a running terminal; the program inside reads the new size back.
#[tokio::test(flavor = "multi_thread")]
async fn resizes_a_running_terminal() {
    let addr = start().await;
    let mut client = Client::connect(addr).await;
    client.send(shell("sz")).await;
    client.frame("spawned", "sz").await;
    client
        .send(json!({ "type": "resize", "id": "sz", "cols": 101, "rows": 31 }))
        .await;
    let (query, answer) = if cfg!(windows) {
        (
            "powershell -NoProfile -Command \"'{0}x{1}' -f [Console]::WindowWidth,[Console]::WindowHeight\"\r\n",
            "101x31",
        )
    } else {
        ("stty size\n", "31 101")
    };
    client
        .send(json!({ "type": "input", "id": "sz", "data": query }))
        .await;
    client.output_until("sz", answer).await;
    client.send(json!({ "type": "kill", "id": "sz" })).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn shutdown_kills_every_running_session() {
    let state = PtyState::new();
    let addr = start_with(state.clone()).await;
    let mut client = Client::connect(addr).await;
    client.send(shell("long")).await;
    client.frame("spawned", "long").await;
    tokio::task::spawn_blocking(move || state.shutdown())
        .await
        .unwrap();
    client.frame("exit", "long").await;
}

#[cfg(unix)]
mod unix {
    use super::*;

    #[tokio::test(flavor = "multi_thread")]
    async fn keeps_characters_whole_across_reads() {
        let addr = start().await;
        let dir = std::env::temp_dir().join(format!("cogpit-pty-utf8-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("euros.txt");
        // 30 000 bytes: no read size divides into whole 3-byte characters.
        std::fs::write(&file, "€".repeat(10_000)).unwrap();

        let mut client = Client::connect(addr).await;
        client
            .send(json!({ "type": "spawn", "id": "cat", "command": "/bin/sh",
                          "args": ["-c", format!("cat '{}'; printf END", file.display())] }))
            .await;
        let output = client.output_until("cat", "END").await;
        assert!(!output.contains('\u{FFFD}'));
        assert_eq!(output.matches('€').count(), 10_000);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// The shell leads its own session with the PTY as its controlling
    /// terminal, so Ctrl-C interrupts the foreground command.
    #[tokio::test(flavor = "multi_thread")]
    async fn delivers_ctrl_c_to_the_foreground_command() {
        let addr = start().await;
        let mut client = Client::connect(addr).await;
        client.send(shell("jc")).await;
        client.frame("spawned", "jc").await;
        // The marker prints right before `sleep` starts, unlike the line's echo.
        client
            .send(json!({ "type": "input", "id": "jc", "data": "echo sl''eeping; sleep 60\n" }))
            .await;
        client.output_until("jc", "sleeping").await;
        // Until `sleep` is the terminal's foreground job a ^C reaches the shell,
        // which ignores it, so it is resent until the prompt comes back.
        let mut seen = String::new();
        for _ in 0..20 {
            client
                .send(json!({ "type": "input", "id": "jc", "data": "\u{3}" }))
                .await;
            let deadline = tokio::time::Instant::now() + Duration::from_millis(500);
            while !seen.contains("$ ") {
                match tokio::time::timeout_at(deadline, client.frame("output", "jc")).await {
                    Ok(frame) => seen.push_str(frame["data"].as_str().unwrap()),
                    Err(_) => break,
                }
            }
            if seen.contains("$ ") {
                break;
            }
        }
        assert!(
            seen.contains("$ "),
            "Ctrl-C did not interrupt sleep: {seen:?}"
        );
        // ^C flushed anything typed ahead, so the answer goes after the prompt.
        client
            .send(json!({ "type": "input", "id": "jc", "data": answer_line() }))
            .await;
        client.output_until("jc", "42").await;
        client.send(json!({ "type": "kill", "id": "jc" })).await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn layers_env_over_the_core_environment() {
        let addr = start().await;
        let mut client = Client::connect(addr).await;
        client
            .send(json!({ "type": "spawn", "id": "env", "command": "/bin/sh",
                          "args": ["-c", "printf '%s|%s|%s\\n' \"$COGPIT_PTY_TEST\" \"$TERM\" \"${PATH:+path}\""],
                          "env": { "COGPIT_PTY_TEST": "layered" } }))
            .await;
        client
            .output_until("env", "layered|xterm-256color|path")
            .await;
    }
}

#[cfg(windows)]
mod windows {
    use super::*;

    /// `binaryResolver.ts` escaping, so the test line is the one sign-in sends.
    fn escape_for_cmd(text: &str) -> String {
        text.chars()
            .flat_map(|c| {
                let special = "()[]%!^\"`<>&|;, *?".contains(c);
                special.then_some('^').into_iter().chain([c])
            })
            .collect()
    }

    /// An npm shim's sign-in reaches the batch file with its arguments intact:
    /// the `/c` line must arrive exactly as `resolveAgentCommand` built it.
    #[tokio::test(flavor = "multi_thread")]
    async fn passes_a_cmd_line_through_verbatim() {
        let addr = start().await;
        let dir = std::env::temp_dir().join(format!("cogpit-pty-shim-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let shim = dir.join("agent.cmd");
        std::fs::write(&shim, "@echo off\r\necho ARGS=%*\r\nexit /b 5\r\n").unwrap();
        let line = [shim.display().to_string()]
            .into_iter()
            .chain(["auth".into(), "lo gin".into()].map(|a: String| format!("\"{a}\"")))
            .map(|part| escape_for_cmd(&part))
            .collect::<Vec<_>>()
            .join(" ");
        let comspec = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into());

        let mut client = Client::connect(addr).await;
        client
            .send(json!({ "type": "spawn", "id": "shim", "command": comspec,
                          "args": format!("/d /s /c \"{line}\"") }))
            .await;
        client
            .output_until("shim", "ARGS=\"auth\" \"lo gin\"")
            .await;
        assert_eq!(client.frame("exit", "shim").await["code"], 5);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// A launcher that starts a writer in its own hidden console, so only the
    /// job object (not the terminal's console closing) can end the writer.
    struct DetachedWriter {
        dir: std::path::PathBuf,
    }

    impl DetachedWriter {
        fn new(name: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("cogpit-pty-{name}-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join("writer.ps1"),
                "$PID | Set-Content \"$PSScriptRoot\\pid.txt\"\r\nwhile ($true) { Add-Content \"$PSScriptRoot\\mark.txt\" x; Start-Sleep -Milliseconds 100 }\r\n",
            )
            .unwrap();
            std::fs::write(
                dir.join("launcher.ps1"),
                "param([switch]$Stay)\r\nStart-Process -WindowStyle Hidden -FilePath powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',\"$PSScriptRoot\\writer.ps1\"\r\nif ($Stay) { Start-Sleep -Seconds 300 }\r\n",
            )
            .unwrap();
            Self { dir }
        }

        fn spawn(&self, id: &str, stay: bool) -> Value {
            let mut args = vec![
                "-NoProfile".to_owned(),
                "-ExecutionPolicy".to_owned(),
                "Bypass".to_owned(),
                "-File".to_owned(),
                self.dir.join("launcher.ps1").display().to_string(),
            ];
            if stay {
                args.push("-Stay".into());
            }
            json!({ "type": "spawn", "id": id, "command": "powershell.exe", "args": args })
        }

        fn size(&self) -> u64 {
            std::fs::metadata(self.dir.join("mark.txt")).map_or(0, |m| m.len())
        }

        async fn wait_until_writing(&self) {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
            while self.size() < 4 {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "the writer never started"
                );
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }

        async fn is_writing(&self) -> bool {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let before = self.size();
            tokio::time::sleep(Duration::from_secs(2)).await;
            self.size() != before
        }
    }

    impl Drop for DetachedWriter {
        fn drop(&mut self) {
            if let Ok(pid) = std::fs::read_to_string(self.dir.join("pid.txt")) {
                let _ = std::process::Command::new("taskkill")
                    .args(["/PID", pid.trim(), "/T", "/F"])
                    .output();
            }
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// A kill ends what the shell started too, as `taskkill /T /F` did, even a
    /// program in a console of its own.
    #[tokio::test(flavor = "multi_thread")]
    async fn kill_ends_the_whole_process_tree() {
        let addr = start().await;
        let writer = DetachedWriter::new("tree");
        let mut client = Client::connect(addr).await;
        client.send(writer.spawn("tree", true)).await;
        client.frame("spawned", "tree").await;
        writer.wait_until_writing().await;

        client.send(json!({ "type": "kill", "id": "tree" })).await;
        client.frame("exit", "tree").await;
        assert!(!writer.is_writing().await, "the writer outlived the kill");
    }

    /// A kill ends the shell's tree by parent, as `taskkill /T /F` always did,
    /// so a program whose launcher already exited (`code .`) keeps running.
    #[tokio::test(flavor = "multi_thread")]
    async fn kill_spares_a_program_whose_launcher_exited() {
        let addr = start().await;
        let writer = DetachedWriter::new("spared");
        let launcher = writer.dir.join("launcher.ps1").display().to_string();
        let mut client = Client::connect(addr).await;
        client
            .send(json!({ "type": "spawn", "id": "spared", "command": "cmd.exe",
                          "args": format!("/d /s /c \"powershell -NoProfile -ExecutionPolicy Bypass -File \"{launcher}\" & ping -n 300 127.0.0.1 > nul\"") }))
            .await;
        client.frame("spawned", "spared").await;
        writer.wait_until_writing().await;

        client.send(json!({ "type": "kill", "id": "spared" })).await;
        client.frame("exit", "spared").await;
        assert!(
            writer.is_writing().await,
            "the kill reached a program whose launcher had exited"
        );
    }

    /// A shell that exits on its own leaves what it started detached running,
    /// as an editor opened from the terminal must keep running.
    #[tokio::test(flavor = "multi_thread")]
    async fn natural_exit_leaves_detached_programs_running() {
        let addr = start().await;
        let writer = DetachedWriter::new("detached");
        let mut client = Client::connect(addr).await;
        client.send(writer.spawn("detached", false)).await;
        assert_eq!(client.frame("exit", "detached").await["code"], 0);
        writer.wait_until_writing().await;
        assert!(
            writer.is_writing().await,
            "the writer died with its terminal"
        );
    }
}
