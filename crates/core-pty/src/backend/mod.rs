//! Starting a process on a pseudo-terminal: `portable-pty` on Unix, ConPTY
//! driven directly on Windows (see `windows.rs` for why).

use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::sync::Arc;

pub mod cmdline;
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
pub use unix::spawn;
#[cfg(windows)]
pub use windows::spawn;

/// What follows the program on its command line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Args {
    /// Separate arguments, quoted for the platform.
    List(Vec<String>),
    /// One string. On Windows it is the rest of the command line exactly as
    /// given, which `cmd.exe /d /s /c "…"` needs; elsewhere it is one argument.
    CommandLine(String),
}

pub struct SpawnSpec {
    pub command: String,
    pub args: Args,
    pub cwd: PathBuf,
    /// Layered over this process's environment.
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
}

/// Control over a running terminal process.
pub trait Process: Send + Sync {
    fn resize(&self, cols: u16, rows: u16) -> io::Result<()>;
    /// Ends the process and its descendants. Blocks while `taskkill` runs on
    /// Windows, so it is called off the async runtime.
    fn kill(&self);
}

pub struct Spawned {
    pub process: Arc<dyn Process>,
    pub input: Box<dyn Write + Send>,
    pub output: Box<dyn Read + Send>,
    /// Blocks until the process exits and returns its exit code.
    pub wait: Box<dyn FnOnce() -> i64 + Send>,
}

/// The shell a terminal runs when the client names no command.
pub fn default_shell() -> String {
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
    }
}
