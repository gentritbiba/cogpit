//! `portable-pty` starts the child as a session leader with the PTY as its
//! controlling terminal (`setsid` + `TIOCSCTTY`), so job control and Ctrl-C
//! reach the foreground command.

use std::io;
use std::sync::{Arc, Mutex};

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};

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
    let output = pair.master.try_clone_reader().map_err(io::Error::other)?;
    let input = pair.master.take_writer().map_err(io::Error::other)?;
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
