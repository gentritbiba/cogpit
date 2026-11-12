//! `portable-pty` starts the child as a session leader with the PTY as its
//! controlling terminal (`setsid` + `TIOCSCTTY`), so job control and Ctrl-C
//! reach the foreground command.
//!
//! The terminal is non-blocking: the registry reads and writes every
//! terminal on one thread.

use std::io;
use std::os::fd::{AsFd, OwnedFd};
use std::sync::{Arc, Mutex};

use filedescriptor::FileDescriptor;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::unix::pipe;
use tokio::runtime::Handle;
use tokio::sync::mpsc;

use super::{Args, Process, SpawnSpec, Spawned};

struct UnixProcess {
    master: Mutex<Box<dyn MasterPty + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

impl Process for UnixProcess {
    fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        let master = self.master.lock().unwrap_or_else(|e| e.into_inner());
        master.resize(size(cols, rows)).map_err(io::Error::other)
    }

    /// SIGHUP, as a closing terminal sends; the kernel passes it on to the
    /// foreground job when the session leader exits.
    fn kill(&self) {
        let mut killer = self.killer.lock().unwrap_or_else(|e| e.into_inner());
        let _ = killer.kill();
    }
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

pub fn spawn(spec: SpawnSpec) -> io::Result<Spawned> {
    let pair = native_pty_system()
        .openpty(size(spec.cols, spec.rows))
        .map_err(io::Error::other)?;
    let mut command = CommandBuilder::new(&spec.command);
    match spec.args {
        Args::List(args) => command.args(args),
        Args::CommandLine(line) => command.arg(line),
    }
    command.cwd(&spec.cwd);
    for (key, value) in spec.env {
        command.env(key, value);
    }
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(io::Error::other)?;
    // Only the child may hold the terminal side, or the master never sees EOF.
    drop(pair.slave);
    let master = pair
        .master
        .as_raw_fd()
        .ok_or_else(|| io::Error::other("the terminal has no file descriptor"))?;
    let mut terminal = FileDescriptor::dup(&master).map_err(io::Error::other)?;
    terminal.set_non_blocking(true).map_err(io::Error::other)?;
    let input = Input(terminal.as_fd().try_clone_to_owned()?);
    let output = Output(terminal.as_fd().try_clone_to_owned()?);
    let process = UnixProcess {
        killer: Mutex::new(child.clone_killer()),
        master: Mutex::new(pair.master),
    };
    Ok(Spawned {
        process: Arc::new(process),
        input,
        output,
        wait: Box::new(move || {
            child
                .wait()
                .map_or(1, |status| i64::from(status.exit_code()))
        }),
    })
}

/// The terminal's input.
pub struct Input(OwnedFd);

impl Input {
    /// Writes what the returned channel receives, in order, on `runtime`,
    /// waiting while the terminal is full, until the channel or the terminal
    /// closes.
    pub fn start(self, runtime: &Handle) -> mpsc::UnboundedSender<Vec<u8>> {
        let (sender, mut received) = mpsc::unbounded_channel::<Vec<u8>>();
        runtime.spawn(async move {
            // Tokio's pipe writer takes any non-blocking descriptor; it only
            // writes and waits for room, which a terminal supports the same way.
            let Ok(mut terminal) = pipe::Sender::from_owned_fd_unchecked(self.0) else {
                return;
            };
            while let Some(data) = received.recv().await {
                if terminal.write_all(&data).await.is_err() {
                    break;
                }
            }
        });
        sender
    }
}

/// The terminal's output.
pub struct Output(OwnedFd);

impl Output {
    /// Registers the output with the calling runtime's reactor. Like
    /// [`Input`], it goes through Tokio's pipe reader.
    pub fn reader(self) -> io::Result<OutputReader> {
        pipe::Receiver::from_owned_fd_unchecked(self.0).map(OutputReader)
    }
}

pub struct OutputReader(pipe::Receiver);

impl OutputReader {
    /// Reads what the terminal has; 0 at its end. Cancel-safe.
    pub async fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.0.read(buffer).await
    }
}
