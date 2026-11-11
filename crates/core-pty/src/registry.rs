//! Terminal sessions and the clients watching them.
//!
//! Locks are taken in one order only: the session map, then a session, then
//! the client list.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::ws::Utf8Bytes;
use indexmap::IndexMap;
use serde_json::{Map, Value};
use tokio::sync::mpsc;

use crate::backend::{self, Args, Process, SpawnSpec};
use crate::protocol::{Outbound, SessionInfo, Status};
use crate::scrollback::Scrollback;
use crate::utf8::StreamDecoder;

pub type ClientId = u64;
pub type Outbox = mpsc::UnboundedSender<Utf8Bytes>;

/// How long an exit waits for the last output. Output ends when every holder
/// of the terminal closes it, which a background job can put off indefinitely.
const OUTPUT_DRAIN: Duration = Duration::from_millis(500);
const READ_BUFFER: usize = 16 * 1024;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

struct Session {
    id: String,
    created_at: u64,
    cwd: String,
    metadata: Option<Value>,
    state: Mutex<SessionState>,
}

struct SessionState {
    name: String,
    status: Status,
    exit_code: Option<i64>,
    scrollback: Scrollback,
    clients: HashMap<ClientId, Outbox>,
    /// Dropped at exit, which releases the terminal and, on Windows, ends
    /// whatever the process left running.
    process: Option<Arc<dyn Process>>,
    input: Option<std_mpsc::Sender<Vec<u8>>>,
}

impl Session {
    fn info(&self) -> SessionInfo {
        let state = lock(&self.state);
        SessionInfo {
            id: self.id.clone(),
            name: state.name.clone(),
            status: state.status,
            exit_code: state.exit_code,
            created_at: self.created_at,
            cwd: self.cwd.clone(),
            metadata: self.metadata.clone(),
        }
    }
}

#[derive(Default)]
pub struct Registry {
    sessions: Mutex<IndexMap<String, Arc<Session>>>,
    clients: Mutex<HashMap<ClientId, Outbox>>,
    next_client: AtomicU64,
}

impl Registry {
    pub fn connect(&self, outbox: Outbox) -> ClientId {
        let client = self.next_client.fetch_add(1, Ordering::Relaxed);
        lock(&self.clients).insert(client, outbox);
        client
    }

    pub fn disconnect(&self, client: ClientId) {
        lock(&self.clients).remove(&client);
        for session in lock(&self.sessions).values() {
            lock(&session.state).clients.remove(&client);
        }
    }

    /// Ends every session; called when the core shuts down.
    pub fn shutdown(&self) {
        let sessions = std::mem::take(&mut *lock(&self.sessions));
        for session in sessions.values() {
            let state = lock(&session.state);
            if let Some(process) = &state.process {
                process.kill();
            }
        }
    }

    pub async fn handle(self: &Arc<Self>, client: ClientId, outbox: &Outbox, text: &str) {
        let message = match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(message)) => message,
            Ok(Value::Null) | Err(_) => {
                let id = Value::String(String::new());
                send(
                    outbox,
                    &Outbound::Error {
                        id: &id,
                        message: "Invalid JSON",
                    },
                );
                return;
            }
            Ok(_) => return,
        };
        match message.get("type").and_then(Value::as_str) {
            Some("spawn") => self.spawn(client, outbox, message).await,
            Some("input") => self.input(&message),
            Some("resize") => self.resize(&message),
            Some("kill") => self.kill(&message),
            Some("attach") => self.attach(client, outbox, &message),
            Some("list") => send(
                outbox,
                &Outbound::Sessions {
                    sessions: &self.infos(),
                },
            ),
            Some("rename") => self.rename(&message),
            _ => {}
        }
    }

    async fn spawn(
        self: &Arc<Self>,
        client: ClientId,
        outbox: &Outbox,
        message: Map<String, Value>,
    ) {
        let id = non_empty(&message, "id").unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let error = |text: &str| {
            let id = Value::String(id.clone());
            send(
                outbox,
                &Outbound::Error {
                    id: &id,
                    message: text,
                },
            );
        };
        if lock(&self.sessions).contains_key(&id) {
            return error("Session ID already exists");
        }
        let name = non_empty(&message, "name")
            .unwrap_or_else(|| format!("Terminal {}", lock(&self.sessions).len() + 1));
        let cwd = non_empty(&message, "cwd").unwrap_or_else(home_dir);
        let spec = SpawnSpec {
            command: non_empty(&message, "command").unwrap_or_else(backend::default_shell),
            args: match message.get("args") {
                Some(Value::String(line)) => Args::CommandLine(line.clone()),
                Some(Value::Array(args)) => Args::List(
                    args.iter()
                        .map(|arg| arg.as_str().map_or_else(|| arg.to_string(), str::to_owned))
                        .collect(),
                ),
                _ => Args::List(Vec::new()),
            },
            cwd: PathBuf::from(&cwd),
            env: environment(&message),
            cols: dimension(&message, "cols").unwrap_or(80),
            rows: dimension(&message, "rows").unwrap_or(24),
        };

        let spawned = tokio::task::spawn_blocking(move || backend::spawn(spec)).await;
        let spawned = match spawned {
            Ok(Ok(spawned)) => spawned,
            Ok(Err(err)) => return error(&format!("Failed to spawn PTY: {err}")),
            Err(err) => return error(&format!("Failed to spawn PTY: {err}")),
        };

        let (input_tx, input_rx) = std_mpsc::channel();
        let session = Arc::new(Session {
            id: id.clone(),
            created_at: now_ms(),
            cwd,
            metadata: message.get("metadata").cloned(),
            state: Mutex::new(SessionState {
                name: name.clone(),
                status: Status::Running,
                exit_code: None,
                scrollback: Scrollback::default(),
                clients: HashMap::from([(client, outbox.clone())]),
                process: Some(Arc::clone(&spawned.process)),
                input: Some(input_tx),
            }),
        });
        {
            let mut sessions = lock(&self.sessions);
            if sessions.contains_key(&id) {
                drop(sessions);
                spawned.process.kill();
                return error("Session ID already exists");
            }
            sessions.insert(id.clone(), Arc::clone(&session));
        }
        send(
            outbox,
            &Outbound::Spawned {
                id: &id,
                name: &name,
            },
        );
        self.broadcast_sessions();
        self.run(
            session,
            spawned.input,
            input_rx,
            spawned.output,
            spawned.wait,
        );
    }

    /// One thread each for input, output and the exit wait: all three block.
    fn run(
        self: &Arc<Self>,
        session: Arc<Session>,
        mut input: Box<dyn Write + Send>,
        input_rx: std_mpsc::Receiver<Vec<u8>>,
        mut output: Box<dyn Read + Send>,
        wait: Box<dyn FnOnce() -> i64 + Send>,
    ) {
        std::thread::spawn(move || {
            for data in input_rx {
                if input.write_all(&data).and_then(|()| input.flush()).is_err() {
                    break;
                }
            }
        });

        let (drained_tx, drained_rx) = std_mpsc::channel::<()>();
        let reader_session = Arc::clone(&session);
        std::thread::spawn(move || {
            let mut decoder = StreamDecoder::default();
            let mut buffer = vec![0; READ_BUFFER];
            loop {
                match output.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => output_to(&reader_session, &decoder.decode(&buffer[..read])),
                    Err(err) if err.kind() == std::io::ErrorKind::Interrupted => {}
                    // EIO on Linux and a broken pipe on Windows mean the end.
                    Err(_) => break,
                }
            }
            output_to(&reader_session, &decoder.finish());
            drop(drained_tx);
        });

        let registry = Arc::clone(self);
        std::thread::spawn(move || {
            let code = wait();
            let _ = drained_rx.recv_timeout(OUTPUT_DRAIN);
            registry.exited(&session, code);
        });
    }

    fn exited(&self, session: &Session, code: i64) {
        {
            let mut state = lock(&session.state);
            state.status = Status::Exited;
            state.exit_code = Some(code);
            state.process = None;
            state.input = None;
            let frame = Outbound::Exit {
                id: &session.id,
                code: Some(code),
            }
            .frame();
            for outbox in state.clients.values() {
                let _ = outbox.send(frame.clone());
            }
        }
        self.broadcast_sessions();
    }

    fn session(&self, message: &Map<String, Value>) -> Option<Arc<Session>> {
        let id = message.get("id")?.as_str()?;
        lock(&self.sessions).get(id).cloned()
    }

    fn input(&self, message: &Map<String, Value>) {
        let (Some(session), Some(data)) = (
            self.session(message),
            message.get("data").and_then(Value::as_str),
        ) else {
            return;
        };
        if let Some(input) = &lock(&session.state).input {
            let _ = input.send(data.as_bytes().to_vec());
        }
    }

    fn resize(&self, message: &Map<String, Value>) {
        let (Some(session), Some(cols), Some(rows)) = (
            self.session(message),
            dimension(message, "cols"),
            dimension(message, "rows"),
        ) else {
            return;
        };
        if let Some(process) = &lock(&session.state).process
            && let Err(err) = process.resize(cols, rows)
        {
            tracing::debug!(id = %session.id, %err, "terminal resize failed");
        }
    }

    fn kill(&self, message: &Map<String, Value>) {
        let Some(id) = message.get("id").and_then(Value::as_str) else {
            return;
        };
        let Some(session) = lock(&self.sessions).shift_remove(id) else {
            return;
        };
        if let Some(process) = &lock(&session.state).process {
            process.kill();
        }
        self.broadcast_sessions();
    }

    fn attach(&self, client: ClientId, outbox: &Outbox, message: &Map<String, Value>) {
        let Some(session) = self.session(message) else {
            let id = message.get("id").cloned().unwrap_or(Value::Null);
            send(
                outbox,
                &Outbound::Error {
                    id: &id,
                    message: "Session not found",
                },
            );
            return;
        };
        let mut state = lock(&session.state);
        state.clients.insert(client, outbox.clone());
        let scrollback = state.scrollback.as_str();
        if !scrollback.is_empty() {
            send(
                outbox,
                &Outbound::Output {
                    id: &session.id,
                    data: scrollback,
                },
            );
        }
        if state.status == Status::Exited {
            send(
                outbox,
                &Outbound::Exit {
                    id: &session.id,
                    code: state.exit_code,
                },
            );
        }
    }

    fn rename(&self, message: &Map<String, Value>) {
        let (Some(session), Some(name)) = (
            self.session(message),
            message.get("name").and_then(Value::as_str),
        ) else {
            return;
        };
        lock(&session.state).name = name.to_owned();
        self.broadcast_sessions();
    }

    fn infos(&self) -> Vec<SessionInfo> {
        lock(&self.sessions)
            .values()
            .map(|session| session.info())
            .collect()
    }

    /// Holds the session map while sending so lists reach clients in order.
    fn broadcast_sessions(&self) {
        let sessions = lock(&self.sessions);
        let infos: Vec<SessionInfo> = sessions.values().map(|session| session.info()).collect();
        let frame = Outbound::Sessions { sessions: &infos }.frame();
        for outbox in lock(&self.clients).values() {
            let _ = outbox.send(frame.clone());
        }
    }
}

fn output_to(session: &Session, data: &str) {
    if data.is_empty() {
        return;
    }
    let mut state = lock(&session.state);
    state.scrollback.push(data);
    let frame = Outbound::Output {
        id: &session.id,
        data,
    }
    .frame();
    for outbox in state.clients.values() {
        let _ = outbox.send(frame.clone());
    }
}

fn send(outbox: &Outbox, message: &Outbound<'_>) {
    let _ = outbox.send(message.frame());
}

fn non_empty(message: &Map<String, Value>, key: &str) -> Option<String> {
    message
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn dimension(message: &Map<String, Value>, key: &str) -> Option<u16> {
    message
        .get(key)
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .map(|value| u16::try_from(value).unwrap_or(u16::MAX))
}

/// The spawn's `env`, then `TERM`, layered over the core's own environment.
fn environment(message: &Map<String, Value>) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = message
        .get("env")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(key, value)| Some((key.clone(), value.as_str()?.to_owned())))
        .collect();
    env.push(("TERM".into(), "xterm-256color".into()));
    env
}

fn home_dir() -> String {
    std::env::home_dir().map_or_else(|| ".".into(), |home| home.to_string_lossy().into_owned())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}
