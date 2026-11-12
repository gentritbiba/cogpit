//! Running `git` and locating the repository around a request cwd, as
//! `server/lib/gitProject.ts` does.

use std::io;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

use crate::fsx::{lossy, realpath};
use crate::http::Failure;
use crate::paths::native;

/// Per-stream output ceiling (`maxBuffer`), in bytes of decoded UTF-8 as
/// Node counts it.
const MAX_OUTPUT: usize = 8 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug)]
pub enum GitError {
    /// `git` could not be spawned: not installed, or not on PATH.
    NotFound,
    /// Non-zero exit, with stderr.
    Failed(String),
    /// Timed out, overflowed the output ceiling, or failed some other way.
    Other,
}

/// Read and decode a whole stream, failing as soon as it passes
/// `MAX_OUTPUT`. Replacement characters only ever lengthen the text, so a raw
/// stream past the ceiling is past it decoded too.
async fn read_capped(stream: impl AsyncRead + Unpin) -> Result<String, GitError> {
    let mut output = Vec::new();
    let limit = u64::try_from(MAX_OUTPUT).unwrap_or(u64::MAX) + 1;
    stream
        .take(limit)
        .read_to_end(&mut output)
        .await
        .map_err(|_| GitError::Other)?;
    let text = lossy(output);
    if text.len() > MAX_OUTPUT {
        return Err(GitError::Other);
    }
    Ok(text)
}

/// `git <args>` in `cwd`; stdout, decoded as UTF-8, on success.
pub async fn run_git(cwd: &str, args: &[&str]) -> Result<String, GitError> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW, Node's `windowsHide`
    let mut child = command.spawn().map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => GitError::NotFound,
        _ => GitError::Other,
    })?;
    let stdout = child.stdout.take().ok_or(GitError::Other)?;
    let stderr = child.stderr.take().ok_or(GitError::Other)?;
    let run = async {
        let (stdout, stderr) = tokio::try_join!(read_capped(stdout), read_capped(stderr))?;
        let status = child.wait().await.map_err(|_| GitError::Other)?;
        if status.success() {
            Ok(stdout)
        } else {
            Err(GitError::Failed(stderr))
        }
    };
    tokio::time::timeout(TIMEOUT, run)
        .await
        .unwrap_or(Err(GitError::Other))
}

pub struct GitProject {
    /// Canonical path of the requested cwd.
    pub project_path: String,
    /// Repository root, or `None` when the cwd is not inside a repository.
    pub root: Option<String>,
}

/// Canonicalize a request cwd and locate the repository that contains it.
pub async fn resolve_git_project(cwd: &str) -> Result<GitProject, Failure> {
    if !native::is_absolute(cwd) {
        return Err(Failure(400, "cwd must be an absolute path"));
    }
    let project_path = match realpath(&native::resolve(&[cwd])).await {
        Ok(path) => path,
        Err(_) => return Err(Failure(404, "Project directory not found")),
    };
    match tokio::fs::metadata(&project_path).await {
        Ok(info) if info.is_dir() => {}
        Ok(_) => return Err(Failure(400, "cwd must be a directory")),
        Err(_) => return Err(Failure(404, "Project directory not found")),
    }

    match run_git(&project_path, &["rev-parse", "--show-toplevel"]).await {
        Ok(stdout) => match realpath(stdout.trim()).await {
            Ok(root) => Ok(GitProject {
                project_path,
                root: Some(root),
            }),
            Err(_) => Err(Failure(500, "Unable to read the git repository")),
        },
        Err(GitError::NotFound) => Err(Failure(
            503,
            "Git is not installed or not available in PATH",
        )),
        Err(GitError::Failed(stderr)) if stderr.to_lowercase().contains("not a git repository") => {
            Ok(GitProject {
                project_path,
                root: None,
            })
        }
        Err(_) => Err(Failure(500, "Unable to read the git repository")),
    }
}
