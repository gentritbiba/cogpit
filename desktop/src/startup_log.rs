//! The server's output until it is ready, on disk so a failed launch can point
//! at it: a GUI app's own stdout goes nowhere. Each launch starts a fresh file.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub struct StartupLog {
    /// None when the file could not be created.
    pub path: Option<PathBuf>,
    file: Mutex<Option<File>>,
}

impl StartupLog {
    pub fn open(dir: &Path) -> Self {
        let path = dir.join("startup.log");
        // Startup goes on without a log; the error dialog then gives just the reason.
        match fs::create_dir_all(dir).and_then(|()| File::create(&path)) {
            Ok(file) => Self {
                path: Some(path),
                file: Mutex::new(Some(file)),
            },
            Err(_) => Self {
                path: None,
                file: Mutex::new(None),
            },
        }
    }

    pub fn write(&self, line: &str) {
        if let Some(file) = self.file.lock().unwrap().as_mut() {
            // A full disk must not take startup down with it.
            let _ = writeln!(file, "{line}");
        }
    }

    pub fn close(&self) {
        self.file.lock().unwrap().take();
    }
}

/// The body of the "Cogpit could not start" dialog.
pub fn failure_message(reason: &str, log: Option<&Path>) -> String {
    match log {
        Some(path) => format!(
            "{reason}\n\nThe startup log has the details:\n{}",
            path.display()
        ),
        None => reason.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_output_until_closed() {
        let dir = std::env::temp_dir().join(format!("cogpit-startup-log-{}", std::process::id()));
        let log = StartupLog::open(&dir.join("nested"));
        log.write("first");
        log.close();
        log.write("after close");
        let path = log.path.clone().expect("the log was created");
        assert_eq!(fs::read_to_string(&path).unwrap(), "first\n");

        let again = StartupLog::open(&dir.join("nested"));
        again.close();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "",
            "each launch starts a fresh file"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn carries_on_without_a_file_when_the_folder_cannot_be_made() {
        let blocker =
            std::env::temp_dir().join(format!("cogpit-startup-log-file-{}", std::process::id()));
        fs::write(&blocker, "").unwrap();
        let log = StartupLog::open(&blocker.join("logs"));
        assert!(log.path.is_none());
        log.write("ignored");
        fs::remove_file(blocker).unwrap();
    }

    #[test]
    fn points_the_dialog_at_the_log() {
        assert_eq!(failure_message("boom", None), "boom");
        assert_eq!(
            failure_message("boom", Some(Path::new("/tmp/startup.log"))),
            "boom\n\nThe startup log has the details:\n/tmp/startup.log"
        );
    }
}
