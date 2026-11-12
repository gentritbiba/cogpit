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
    ///
    /// On Windows the server and everything it started share a job. A server
    /// that exits in time is let out of it, so what it left running (an editor
    /// opened from a terminal, a dev server an agent started) outlives the app,
    /// as it does on macOS and Linux. `end_leftovers` ends those too: an update
    /// is about to replace the files they may hold open. A server that does not
    /// exit in time is killed, and the job takes everything with it.
    pub fn shut_down(&self, end_leftovers: bool) {
        self.send(&ShellMessage::Shutdown);
        self.stdin.lock().unwrap().take();
        let deadline = Instant::now() + SHUTDOWN_GRACE;
        while Instant::now() < deadline {
            if self.exited() {
                #[cfg(windows)]
                {
                    if end_leftovers {
                        self.job.terminate();
                    } else {
                        self.job.release();
                    }
                }
                #[cfg(not(windows))]
                let _ = end_leftovers;
                return;
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

    /// Windows has no process groups, so killing the server alone would orphan
    /// every agent, git and terminal process it started. Everything in the job
    /// dies when the job is terminated, or when the shell goes away without
    /// having released it.
    pub struct Job(HANDLE);

    // SAFETY: a job handle may be used from any thread.
    unsafe impl Send for Job {}
    // SAFETY: the job's operations are thread-safe kernel calls.
    unsafe impl Sync for Job {}

    impl Job {
        pub fn containing(child: &Child) -> io::Result<Self> {
            // SAFETY: plain kernel calls on a handle this function owns.
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let job = Job(job);
                if !job.kill_on_close(true)
                    || AssignProcessToJobObject(job.0, child.as_raw_handle() as HANDLE) == 0
                {
                    return Err(io::Error::last_os_error());
                }
                Ok(job)
            }
        }

        fn kill_on_close(&self, kill: bool) -> bool {
            // SAFETY: a valid handle and a zeroed, correctly sized limits structure.
            unsafe {
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                if kill {
                    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                }
                SetInformationJobObject(
                    self.0,
                    JobObjectExtendedLimitInformation,
                    (&raw const limits).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) != 0
            }
        }

        /// Let the processes still in the job outlive it.
        pub fn release(&self) {
            self.kill_on_close(false);
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

#[cfg(all(test, windows))]
mod tests {
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command, Stdio};
    use std::thread;
    use std::time::{Duration, Instant};

    use super::windows_job::Job;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    /// Something that stays alive for a while, as a process the server left running would.
    fn long_lived() -> Child {
        Command::new("ping")
            .args(["-n", "60", "127.0.0.1"])
            .stdout(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .expect("start ping")
    }

    fn exits_within(child: &mut Child, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        while Instant::now() < deadline {
            if child.try_wait().expect("poll the child").is_some() {
                return true;
            }
            thread::sleep(Duration::from_millis(50));
        }
        false
    }

    #[test]
    fn closing_the_job_ends_what_is_in_it() {
        let mut child = long_lived();
        drop(Job::containing(&child).expect("create the job"));
        assert!(exits_within(&mut child, Duration::from_secs(5)));
    }

    #[test]
    fn a_released_job_leaves_its_processes_running() {
        let mut child = long_lived();
        let job = Job::containing(&child).expect("create the job");
        job.release();
        drop(job);
        assert!(!exits_within(&mut child, Duration::from_secs(1)));
        child.kill().expect("end ping");
        child.wait().expect("reap ping");
    }

    #[test]
    fn terminating_the_job_ends_what_is_in_it() {
        let mut child = long_lived();
        let job = Job::containing(&child).expect("create the job");
        job.terminate();
        assert!(exits_within(&mut child, Duration::from_secs(5)));
    }
}
