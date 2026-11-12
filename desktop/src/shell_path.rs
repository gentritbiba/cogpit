//! The user's PATH as their login shell sets it. GUI apps don't inherit it on
//! macOS and Linux, and without it the server cannot find the agent CLIs.
//! Windows apps do inherit it, so there is nothing to ask.

use std::time::Duration;

/// How long the login shell gets to report PATH before Cogpit starts without it.
pub const TIMEOUT: Duration = Duration::from_secs(3);

#[cfg(unix)]
pub use unix::{abandon, login_shell_path};

#[cfg(windows)]
pub fn login_shell_path(_shell: &str, _timeout: Duration) -> Option<String> {
    None
}

#[cfg(windows)]
pub fn abandon() {}

#[cfg(unix)]
mod unix {
    use std::collections::HashSet;
    use std::io::Read;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::sync::Mutex;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    const START: &str = "<cogpit-path>";
    const END: &str = "</cogpit-path>";

    /// Probes running now, by the pid that leads each one's process group, so quitting can end them.
    static RUNNING: Mutex<Option<HashSet<u32>>> = Mutex::new(None);

    pub fn login_shell_path(shell: &str, timeout: Duration) -> Option<String> {
        probe(Command::new(shell), timeout)
    }

    /// Ends every probe still running, as the app quits.
    pub fn abandon() {
        let roots = RUNNING.lock().unwrap().take().unwrap_or_default();
        for root in roots {
            kill_process_tree(root);
        }
    }

    /// The PATH is read between markers and taken as soon as it arrives, so
    /// output held open by a job the startup files left running cannot hold it
    /// back. A startup file that waits for input or hangs must not hold the
    /// launch hostage, nor leave processes behind: when the PATH arrives or the
    /// timeout passes, everything the shell started is killed.
    pub(super) fn probe(mut shell: Command, timeout: Duration) -> Option<String> {
        // `wait` keeps the shell, and so the parent links to anything it started, alive until the probe ends.
        let command = format!("printf '%s' \"{START}$PATH{END}\"; wait");
        let mut child = shell
            .args(["-ilc", &command])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .ok()?;
        let root = child.id();
        RUNNING.lock().unwrap().get_or_insert_default().insert(root);

        let mut stdout = child.stdout.take()?;
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let mut output = String::new();
            let mut chunk = [0u8; 4096];
            while let Ok(read) = stdout.read(&mut chunk) {
                if read == 0 {
                    break;
                }
                output.push_str(&String::from_utf8_lossy(&chunk[..read]));
                if let Some(path) = between_markers(&output) {
                    let _ = sender.send(path);
                    return;
                }
            }
            let _ = sender.send(None);
        });

        let path = receiver.recv_timeout(timeout).ok().flatten();
        let still_running = RUNNING
            .lock()
            .unwrap()
            .as_mut()
            .is_some_and(|roots| roots.remove(&root));
        if still_running {
            kill_process_tree(root);
        }
        let _ = child.wait();
        path
    }

    pub(super) fn between_markers(output: &str) -> Option<Option<String>> {
        let end = output.find(END)?;
        let path = output[..end]
            .rfind(START)
            .map(|start| &output[start + START.len()..end])
            .filter(|path| !path.is_empty())
            .map(str::to_owned);
        Some(path)
    }

    /// Kill the process group `root` leads (the probe runs in its own) and the
    /// group of every process still descended from it. A shell with job control
    /// on gives each job a group of its own, which killing only the shell's group
    /// would miss. The tree is read before anything is killed, while the parent
    /// links still hold. SIGKILL, because interactive shells ignore SIGTERM.
    fn kill_process_tree(root: u32) {
        let root = root as i32;
        let mut groups = HashSet::from([root]);
        if let Ok(output) = Command::new("ps")
            .args(["-A", "-o", "pid=,ppid=,pgid="])
            .output()
        {
            let rows: Vec<[i32; 3]> = String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter_map(|line| {
                    let mut fields = line
                        .split_whitespace()
                        .map(|field| field.parse::<i32>().ok());
                    Some([fields.next()??, fields.next()??, fields.next()??])
                })
                .collect();
            let mut tree = HashSet::from([root]);
            let mut grew = true;
            while grew {
                grew = false;
                for [pid, ppid, pgid] in &rows {
                    if !tree.contains(pid) && tree.contains(ppid) {
                        tree.insert(*pid);
                        groups.insert(*pgid);
                        grew = true;
                    }
                }
            }
        }
        for group in groups {
            // SAFETY: kill(2) with a negative pid signals that process group; it touches no memory.
            unsafe {
                libc::kill(-group, libc::SIGKILL);
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::unix::{between_markers, probe};
    use super::*;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::Mutex;
    use std::time::Instant;
    use std::{fs, thread};

    /// Quitting ends every probe, so the tests that run probes take turns.
    static PROBES: Mutex<()> = Mutex::new(());

    #[test]
    fn reads_the_path_between_markers() {
        assert_eq!(
            between_markers("motd\n<cogpit-path>/a:/b</cogpit-path>"),
            Some(Some("/a:/b".into()))
        );
        assert_eq!(between_markers("<cogpit-path>/a"), None);
        assert_eq!(between_markers("<cogpit-path></cogpit-path>"), Some(None));
        assert_eq!(between_markers("</cogpit-path>"), Some(None));
    }

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("cogpit-shell-path-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn is_alive(pid: i32) -> bool {
        // SAFETY: signal 0 only checks that the process exists.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    /// A killed process lingers as a zombie until its new parent reaps it.
    fn expect_gone(pid: i32) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while is_alive(pid) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(25));
        }
        assert!(!is_alive(pid), "process {pid} outlived the probe");
    }

    fn recorded_pid(path: &Path) -> i32 {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(pid) = fs::read_to_string(path)
                .ok()
                .and_then(|text| text.trim().parse().ok())
            {
                return pid;
            }
            assert!(
                Instant::now() < deadline,
                "{} was never written",
                path.display()
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    /// A real login shell with a throwaway HOME whose startup file starts a
    /// background job (which holds the output pipe open) and, optionally, hangs
    /// in the foreground. In bash, `set -m` turns job control on, so those jobs
    /// get process groups of their own, as they do where the shell finds a terminal.
    fn shell_with_startup_file(shell: &str, home: &Path, hang: bool) -> Command {
        let mut lines = vec![
            // zsh refuses job control without a terminal and abandons the file.
            r#"[ -n "$BASH_VERSION" ] && set -m"#.to_owned(),
            "sleep 300 &".to_owned(),
            r#"echo $! > "$HOME/background.pid""#.to_owned(),
        ];
        if hang {
            lines.push(r#"sh -c 'echo $$ > "$HOME/foreground.pid"; exec sleep 300'"#.to_owned());
        }
        for name in [".bash_profile", ".zshrc"] {
            fs::write(home.join(name), lines.join("\n") + "\n").unwrap();
        }
        let mut command = Command::new(shell);
        command.env("HOME", home).env("ZDOTDIR", home);
        command
    }

    fn real_shells() -> impl Iterator<Item = &'static str> {
        ["/bin/bash", "/bin/zsh"]
            .into_iter()
            .filter(|shell| Path::new(shell).exists())
    }

    #[test]
    fn returns_the_path_without_waiting_for_a_job_that_holds_the_output_open() {
        let _turn = PROBES
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for shell in real_shells() {
            let home = scratch(&format!("open-{}", shell.replace('/', "")));
            let started = Instant::now();

            let path = probe(
                shell_with_startup_file(shell, &home, false),
                Duration::from_secs(10),
            );

            let path = path.unwrap_or_else(|| panic!("{shell} reported no PATH"));
            assert!(
                path.split(':').any(|entry| entry == "/usr/bin"),
                "{shell}: {path}"
            );
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "{shell} waited for the job"
            );
            expect_gone(recorded_pid(&home.join("background.pid")));
        }
    }

    #[test]
    fn gives_up_on_a_hung_startup_file_and_leaves_none_of_its_processes_behind() {
        let _turn = PROBES
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for shell in real_shells() {
            let home = scratch(&format!("hung-{}", shell.replace('/', "")));

            assert_eq!(
                probe(
                    shell_with_startup_file(shell, &home, true),
                    Duration::from_secs(2)
                ),
                None
            );

            expect_gone(recorded_pid(&home.join("background.pid")));
            expect_gone(recorded_pid(&home.join("foreground.pid")));
        }
    }

    #[test]
    fn stops_the_probe_and_its_processes_when_the_app_quits_first() {
        let _turn = PROBES
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(shell) = real_shells().next() else {
            return;
        };
        let home = scratch("quit");
        let command = shell_with_startup_file(shell, &home, true);
        let started = Instant::now();
        let running = thread::spawn(move || probe(command, Duration::from_secs(30)));
        let background = recorded_pid(&home.join("background.pid"));
        let foreground = recorded_pid(&home.join("foreground.pid"));

        abandon();

        assert_eq!(running.join().unwrap(), None);
        assert!(started.elapsed() < Duration::from_secs(10));
        expect_gone(background);
        expect_gone(foreground);
    }

    #[test]
    fn returns_none_when_the_shell_fails_prints_nothing_or_is_missing() {
        let _turn = PROBES
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = scratch("broken");
        for (name, body) in [("fails", "exit 1"), ("silent", "true")] {
            let shell = dir.join(name);
            fs::write(&shell, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(&shell, std::os::unix::fs::PermissionsExt::from_mode(0o755))
                .unwrap();
            assert_eq!(
                login_shell_path(shell.to_str().unwrap(), TIMEOUT),
                None,
                "{name}"
            );
        }
        assert_eq!(
            login_shell_path(dir.join("missing").to_str().unwrap(), TIMEOUT),
            None
        );
    }
}
