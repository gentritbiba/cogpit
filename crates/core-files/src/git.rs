//! Running `git` and locating the repository around a request cwd, as
//! `server/lib/gitProject.ts` does.

use std::ffi::{OsStr, OsString};
use std::io;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::OnceCell;

use crate::fsx::{blocking, lossy, realpath};
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

/// macOS puts a shim at `/usr/bin/git` that looks up the selected developer
/// directory on every run, about 6 ms per call. When `git` on `path` is that
/// shim, ask `xcrun` once for the git it would run and run that directly.
#[cfg(target_os = "macos")]
async fn resolve_git(path: Option<OsString>) -> OsString {
    let on_path = path.and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join("git"))
            .find(|candidate| candidate.is_file())
    });
    if on_path.is_some_and(|git| git == std::path::Path::new("/usr/bin/git")) {
        let found = Command::new("/usr/bin/xcrun")
            .args(["--find", "git"])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .output();
        if let Ok(Ok(output)) = tokio::time::timeout(TIMEOUT, found).await
            && output.status.success()
        {
            let git = lossy(output.stdout).trim().to_owned();
            if std::path::Path::new(&git).is_file() {
                return git.into();
            }
        }
    }
    "git".into()
}

#[cfg(not(target_os = "macos"))]
async fn resolve_git(_path: Option<OsString>) -> OsString {
    "git".into()
}

static GIT: OnceCell<OsString> = OnceCell::const_new();

fn git_command(program: &OsStr, cwd: &str, args: &[&str]) -> Command {
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW, Node's `windowsHide`
    command
}

/// `git <args>` in `cwd`; stdout, decoded as UTF-8, on success.
pub async fn run_git(cwd: &str, args: &[&str]) -> Result<String, GitError> {
    let git = GIT
        .get_or_init(|| resolve_git(std::env::var_os("PATH")))
        .await;
    run(git, cwd, args).await
}

async fn run(git: &OsStr, cwd: &str, args: &[&str]) -> Result<String, GitError> {
    let spawned = match git_command(git, cwd, args).spawn() {
        // The git `xcrun` found is gone (Xcode moved or removed); the shim
        // still knows where git lives now.
        Err(error) if error.kind() == io::ErrorKind::NotFound && git != "git" => {
            git_command("git".as_ref(), cwd, args).spawn()
        }
        spawned => spawned,
    };
    let mut child = spawned.map_err(|error| match error.kind() {
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
    let resolved = native::resolve(&[cwd]);
    let project_path = blocking(move || {
        let not_found = Failure(404, "Project directory not found");
        let project_path = realpath(&resolved).map_err(|_| not_found)?;
        match std::fs::metadata(&project_path) {
            Ok(info) if info.is_dir() => Ok(project_path),
            Ok(_) => Err(Failure(400, "cwd must be a directory")),
            Err(_) => Err(not_found),
        }
    })
    .await
    .unwrap_or(Err(Failure(404, "Project directory not found")))?;

    match run_git(&project_path, &["rev-parse", "--show-toplevel"]).await {
        Ok(stdout) => match blocking(move || realpath(stdout.trim())).await {
            Some(Ok(root)) => Ok(GitProject {
                project_path,
                root: Some(root),
            }),
            _ => Err(Failure(500, "Unable to read the git repository")),
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

#[cfg(test)]
mod tests {
    use super::run;

    #[tokio::test]
    async fn a_resolved_git_that_disappeared_falls_back_to_path_lookup() {
        let dir = std::env::temp_dir();
        let missing = dir.join("cogpit-core-no-such-dir").join("git");
        let output = run(missing.as_os_str(), &dir.to_string_lossy(), &["--version"]).await;
        assert!(output.is_ok_and(|text| text.starts_with("git version")));
    }
}

#[cfg(all(test, target_os = "macos"))]
mod macos_tests {
    use super::resolve_git;
    use std::ffi::OsString;

    #[tokio::test]
    async fn the_xcode_shim_resolves_to_the_git_it_would_run() {
        let xcrun = std::process::Command::new("/usr/bin/xcrun")
            .args(["--find", "git"])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned());
        let resolved = resolve_git(Some("/usr/bin:/bin".into())).await;
        assert_eq!(
            resolved,
            OsString::from(xcrun.unwrap_or_else(|| "git".into()))
        );
        assert_ne!(resolved, OsString::from("/usr/bin/git"));
    }

    #[tokio::test]
    async fn any_other_git_on_path_is_left_to_path_lookup() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(dir.path().join("git"), "#!/bin/sh\n").unwrap();
        let path = std::env::join_paths([dir.path(), std::path::Path::new("/usr/bin")]).unwrap();
        assert_eq!(resolve_git(Some(path)).await, OsString::from("git"));
        assert_eq!(resolve_git(None).await, OsString::from("git"));
    }
}
