//! Terminal sessions and the clients watching them.
//!
//! Locks are taken in one order only: the session map, then a session, then
//! the client list.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use indexmap::IndexMap;
use serde_json::{Map, Value};
use tokio::runtime::Handle;
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::backend::{self, Args, Output, Process, SpawnSpec};
use crate::protocol::{Frame, Outbound, SessionInfo, Status};
use crate::scrollback::Scrollback;
use crate::utf8::StreamDecoder;

pub type ClientId = u64;
pub type Outbox = mpsc::UnboundedSender<Frame>;

/// How long an exit waits for the last output. Output ends when every holder
/// of the terminal closes it, which a background job can put off indefinitely.
const OUTPUT_DRAIN: Duration = Duration::from_millis(500);
const READ_BUFFER: usize = 16 * 1024;

/// Output goes out in batches: a frame per read costs a wakeup and a socket
/// write on every hop for each kilobyte a terminal hands over. A read of at
/// least [`FULL_READ`] starts a batch, which is sent when it reaches
/// [`BATCH_BYTES`] or [`BATCH_AGE`] after it started (within 4 ms: the timer
/// counts whole milliseconds). A shorter read with no batch open, such as a
/// keystroke's echo or a prompt, is sent at once.
const BATCH_BYTES: usize = 64 * 1024;
const BATCH_AGE: Duration = Duration::from_millis(3);
/// A read this large usually emptied a full terminal buffer (1 KiB on macOS,
/// 4 KiB on Linux) whose writer is about to refill it.
const FULL_READ: usize = 1024;

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
    /// Output read but not sent yet.
    batch: String,
    clients: HashMap<ClientId, Outbox>,
    /// Dropped at exit, which releases the terminal and, on Windows, ends
    /// whatever the process left running.
    process: Option<Arc<dyn Process>>,
    input: Option<mpsc::UnboundedSender<Vec<u8>>>,
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

    /// Kills every running session and waits for the kills to be sent, as
    /// the server did when it stopped. Blocks.
    pub fn shutdown(&self) {
        let sessions = std::mem::take(&mut *lock(&self.sessions));
        let kills: Vec<_> = sessions
            .values()
            .filter_map(|session| lock(&session.state).process.clone())
            .map(|process| std::thread::spawn(move || process.kill()))
            .collect();
        for kill in kills {
            let _ = kill.join();
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
        // portable-pty would quietly start in HOME instead.
        if !Path::new(&cwd).is_dir() {
            return error(&format!(
                "Failed to spawn PTY: the working directory {cwd} is not a folder"
            ));
        }
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
                batch: String::new(),
                clients: HashMap::from([(client, outbox.clone())]),
                process: Some(Arc::clone(&spawned.process)),
                input: Some(spawned.input.start(terminal_runtime())),
            }),
        });
        {
            let mut sessions = lock(&self.sessions);
            if sessions.contains_key(&id) {
                drop(sessions);
                // Off the runtime: both the kill and the reaping block.
                std::thread::spawn(move || {
                    spawned.process.kill();
                    (spawned.wait)()
                });
                return error("Session ID already exists");
            }
            sessions.insert(id.clone(), Arc::clone(&session));
            // Under the map lock, so no session list naming it can arrive first.
            send(
                outbox,
                &Outbound::Spawned {
                    id: &id,
                    name: &name,
                },
            );
        }
        self.broadcast_sessions();
        self.run(session, spawned.output, spawned.wait);
    }

    /// The output is read on the terminal thread; the exit wait blocks, so it
    /// gets a thread of its own.
    fn run(
        self: &Arc<Self>,
        session: Arc<Session>,
        output: Output,
        wait: Box<dyn FnOnce() -> i64 + Send>,
    ) {
        let (drained_tx, drained_rx) = std_mpsc::channel::<()>();
        terminal_runtime().spawn(send_output(Arc::clone(&session), output, drained_tx));

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
            send_batch(session, &mut state);
            state.status = Status::Exited;
            state.exit_code = Some(code);
            state.process = None;
            state.input = None;
            let frame = Frame::Text(
                Outbound::Exit {
                    id: &session.id,
                    code: Some(code),
                }
                .frame(),
            );
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
        if let Some(process) = lock(&session.state).process.clone() {
            std::thread::spawn(move || process.kill());
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
        let frame = Frame::Text(Outbound::Sessions { sessions: &infos }.frame());
        for outbox in lock(&self.clients).values() {
            let _ = outbox.send(frame.clone());
        }
    }
}

/// Sends the batch to every client and adds it to the scrollback, together,
/// so a client attaching in between sees each part exactly once. Output after
/// the exit was reported belongs to whatever the process left running on its
/// terminal; the session has ended, so it is dropped.
fn send_batch(session: &Session, state: &mut SessionState) {
    if state.batch.is_empty() {
        return;
    }
    if state.status == Status::Running {
        state.scrollback.push(&state.batch);
    }
    if state.status == Status::Running && !state.clients.is_empty() {
        let frame = Frame::output(session.id.clone(), state.batch.clone());
        for outbox in state.clients.values() {
            let _ = outbox.send(frame.clone());
        }
    }
    state.batch.clear();
}

/// One thread reads and writes every terminal. Readers on threads of their
/// own contend in the kernel: on macOS, eight terminals printing at once cost
/// five times the CPU that one thread reading all eight does. Writing there
/// too means a keystroke's echo is read without waking another thread.
fn terminal_runtime() -> &'static Handle {
    static RUNTIME: OnceLock<Handle> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .enable_time()
            .build()
            .expect("the terminal runtime starts");
        let handle = runtime.handle().clone();
        std::thread::Builder::new()
            .name("pty-io".into())
            .spawn(move || runtime.block_on(std::future::pending::<()>()))
            .expect("the terminal thread starts");
        handle
    })
}

/// Reads a terminal until its end, sending the output in batches. Dropping
/// `drained` tells the exit wait that all of it was sent.
async fn send_output(session: Arc<Session>, output: Output, drained: std_mpsc::Sender<()>) {
    let mut reader = match output.reader() {
        Ok(reader) => reader,
        Err(err) => {
            tracing::warn!(id = %session.id, %err, "terminal output cannot be read");
            return;
        }
    };
    let mut decoder = StreamDecoder::default();
    let mut buffer = vec![0; READ_BUFFER];
    let batch_due = tokio::time::sleep(BATCH_AGE);
    tokio::pin!(batch_due);
    let mut batching = false;
    loop {
        let read = tokio::select! {
            biased;
            read = reader.read(&mut buffer) => read,
            () = &mut batch_due, if batching => {
                batching = false;
                send_batch(&session, &mut lock(&session.state));
                continue;
            }
        };
        let read = match read {
            Ok(0) => break,
            Ok(read) => read,
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            // EIO on Linux and a broken pipe on Windows mean the end.
            Err(_) => break,
        };
        let mut state = lock(&session.state);
        decoder.decode(&buffer[..read], &mut state.batch);
        if state.batch.len() >= BATCH_BYTES || (read < FULL_READ && !batching) {
            batching = false;
            send_batch(&session, &mut state);
        } else if !batching {
            batching = true;
            batch_due.as_mut().reset(Instant::now() + BATCH_AGE);
        }
    }
    let mut state = lock(&session.state);
    decoder.finish(&mut state.batch);
    send_batch(&session, &mut state);
    drop(state);
    drop(drained);
}

fn send(outbox: &Outbox, message: &Outbound<'_>) {
    let _ = outbox.send(Frame::Text(message.frame()));
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
