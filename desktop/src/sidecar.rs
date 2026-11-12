//! The API server, run as a child process on the Bun runtime the app ships.
//! It speaks the protocol in `protocol.rs` over its stdin and stdout; its
//! stderr is its log. Closing its stdin tells it the shell is gone.

use std::io::{self, BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::protocol::{
    Notify, ServerMessage, ShellMessage, encode_shell_message, parse_server_line,
};
use crate::startup_log::StartupLog;

pub const START_TIMEOUT: Duration = Duration::from_secs(15);
/// How long the server gets to save its state and exit before it is killed.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

pub struct Launch {
    pub runtime: PathBuf,
    pub script: PathBuf,
    pub static_dir: PathBuf,
    pub data_dir: PathBuf,
    /// The login shell's PATH, which agents need to find their CLIs.
    pub path: Option<String>,
    /// The Rust core the server supervises, as this build ships it; a dev
    /// build leaves it out and the server finds the checkout's own build.
    pub core_bin: Option<PathBuf>,
}

pub enum Startup {
    Ready(u16),
    Failed(String),
}

pub struct Sidecar {
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>,
    pid: u32,
    #[cfg(windows)]
    job: windows_job::Job,
}

impl Sidecar {
    pub fn spawn(
        launch: &Launch,
        log: Arc<StartupLog>,
        on_notify: impl Fn(Notify) + Send + 'static,
    ) -> io::Result<(Arc<Self>, Receiver<Startup>)> {
        let mut command = Command::new(&launch.runtime);
        command
            .arg(&launch.script)
            .arg("--static-dir")
            .arg(&launch.static_dir)
            .arg("--data-dir")
            .arg(&launch.data_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(path) = &launch.path {
            command.env("PATH", path);
        }
        // An argument, not COGPIT_CORE_BIN: every process the server starts
        // inherits its environment, and a Cogpit run from source in one of its
        // terminals would take this binary over its own build.
        if let Some(core_bin) = &launch.core_bin {
            command.arg("--core-bin").arg(core_bin);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command.spawn()?;
        let pid = child.id();
        #[cfg(windows)]
        let job = windows_job::Job::containing(&child)?;
        let stdout = child.stdout.take().expect("stdout is piped");
        let stderr = child.stderr.take().expect("stderr is piped");
        let stdin = child.stdin.take();
        let sidecar = Arc::new(Self {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            pid,
            #[cfg(windows)]
            job,
        });

        let (startup, started) = mpsc::channel();
        let messages_log = log.clone();
        let ready = startup.clone();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                match parse_server_line(&line) {
                    Some(ServerMessage::Ready { port }) => {
                        let _ = ready.send(Startup::Ready(port));
                    }
                    Some(ServerMessage::Error { error }) => {
                        let _ = ready.send(Startup::Failed(error));
                    }
                    Some(ServerMessage::Notify(notify)) => on_notify(notify),
                    None => log_line(&messages_log, &line),
                }
            }
        });
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                log_line(&log, &line);
            }
        });
        watch_exit(sidecar.clone(), startup);
        Ok((sidecar, started))
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn send(&self, message: &ShellMessage) {
        let mut stdin = self.stdin.lock().unwrap();
        let Some(pipe) = stdin.as_mut() else { return };
        if pipe
            .write_all(encode_shell_message(message).as_bytes())
            .and_then(|()| pipe.flush())
            .is_err()
        {
            stdin.take();
        }
    }

    /// Ask the server to save what it needs and exit, then make sure it has.
    /// On Windows the job object also takes every process the server started.
    pub fn shut_down(&self) {
        self.send(&ShellMessage::Shutdown);
        self.stdin.lock().unwrap().take();
        let deadline = Instant::now() + SHUTDOWN_GRACE;
        while Instant::now() < deadline {
            if self.exited() {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        let _ = self.child.lock().unwrap().kill();
        #[cfg(windows)]
        self.job.terminate();
    }

    fn exited(&self) -> bool {
        self.child
            .lock()
            .unwrap()
            .try_wait()
            .map_or(true, |status| status.is_some())
    }
}

fn log_line(log: &StartupLog, line: &str) {
    eprintln!("{line}");
    log.write(line);
}

/// Report an exit before the server was ready as a failed start; afterwards just log it.
fn watch_exit(sidecar: Arc<Sidecar>, startup: Sender<Startup>) {
    thread::spawn(move || {
        loop {
            thread::sleep(Duration::from_millis(250));
            let status = match sidecar.child.lock().unwrap().try_wait() {
                Ok(Some(status)) => status,
                Ok(None) => continue,
                Err(_) => return,
            };
            let code = status
                .code()
                .map_or_else(|| "a signal".to_owned(), |code| format!("exit code {code}"));
            eprintln!("[shell] The server stopped ({code})");
            let _ = startup.send(Startup::Failed(format!(
                "The server stopped before it was ready ({code})."
            )));
            return;
        }
    });
}

#[cfg(windows)]
mod windows_job {
    use std::io;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject,
    };

    /// Windows has no process groups, so ending the server alone would orphan
    /// every agent, git and terminal process it started. Everything in the job
    /// dies with it, and with the shell should the shell itself be killed.
    pub struct Job(HANDLE);

    // SAFETY: a job handle may be used from any thread.
    unsafe impl Send for Job {}
    // SAFETY: the job's operations are thread-safe kernel calls.
    unsafe impl Sync for Job {}

    impl Job {
        pub fn containing(child: &Child) -> io::Result<Self> {
            // SAFETY: plain kernel calls on a handle this function owns, with a
            // zeroed, correctly sized limits structure.
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let job = Job(job);
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let configured = SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    (&raw const limits).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if configured == 0
                    || AssignProcessToJobObject(job.0, child.as_raw_handle() as HANDLE) == 0
                {
                    return Err(io::Error::last_os_error());
                }
                Ok(job)
            }
        }

        pub fn terminate(&self) {
            // SAFETY: the handle is valid until drop.
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: the handle is owned and closed exactly once.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}
