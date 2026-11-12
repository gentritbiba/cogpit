//! `GET git-diff?cwd=&path=&originalPath=`: a file's committed and
//! working-tree contents, for the diff viewer.

use axum::http::{StatusCode, Uri};
use axum::response::Response;
use serde::Serialize;

use crate::fsx::{lossy, realpath};
use crate::git::{resolve_git_project, run_git};
use crate::http::{error, json, query_param};
use crate::paths::native;

const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;
/// Git's own heuristic: a NUL byte in the first 8000 bytes means "binary".
const BINARY_SNIFF_BYTES: usize = 8000;

#[derive(Debug, PartialEq, Eq)]
pub struct DiffSide {
    /// File contents, or `None` when the file does not exist on this side.
    pub content: Option<String>,
    pub binary: bool,
    pub too_large: bool,
}

pub fn read_side(bytes: Option<Vec<u8>>) -> DiffSide {
    let absent = DiffSide {
        content: None,
        binary: false,
        too_large: false,
    };
    let Some(bytes) = bytes else { return absent };
    if bytes[..bytes.len().min(BINARY_SNIFF_BYTES)].contains(&0) {
        return DiffSide {
            binary: true,
            ..absent
        };
    }
    if bytes.len() > MAX_DIFF_BYTES {
        return DiffSide {
            too_large: true,
            ..absent
        };
    }
    DiffSide {
        content: Some(lossy(bytes)),
        ..absent
    }
}

/// The blob at `HEAD`, or `None` for a new file or a repository without
/// commits. It went through UTF-8 decoding, as the TypeScript route read it
/// through a string.
async fn read_committed_blob(root: &str, repo_path: &str) -> Option<Vec<u8>> {
    let stdout = run_git(root, &["show", &format!("HEAD:{repo_path}")])
        .await
        .ok()?;
    Some(stdout.into_bytes())
}

/// The working-tree file, resolved through symlinks so a link inside the
/// repository cannot serve a file outside it.
async fn read_working_file(root: &str, absolute_path: &str) -> Option<Vec<u8>> {
    let real = realpath(absolute_path).await.ok()?;
    if !native::is_within_dir(root, &real) {
        return None;
    }
    tokio::fs::read(&real).await.ok()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiffResponse {
    path: String,
    original: Option<String>,
    current: Option<String>,
    binary: bool,
    too_large: bool,
}

pub async fn handler(uri: Uri) -> Response {
    let query = uri.query();
    let cwd = query_param(query, "cwd").unwrap_or_default();
    let file_path = query_param(query, "path").unwrap_or_default();
    // Renames diff against the pre-rename blob, which lives at a different path.
    let original_path = query_param(query, "originalPath")
        .filter(|path| !path.is_empty())
        .unwrap_or_else(|| file_path.clone());

    if file_path.is_empty() || native::is_absolute(&file_path) || file_path.contains('\0') {
        return error(400, "path must be a relative project file");
    }
    let project = match resolve_git_project(&cwd).await {
        Ok(project) => project,
        Err(failure) => return failure.respond(),
    };
    let Some(root) = project.root else {
        return error(400, "Not a git repository");
    };

    let head_candidate = native::resolve(&[&project.project_path, &original_path]);
    let absolute_path = native::resolve(&[&project.project_path, &file_path]);
    let contained = native::is_within_dir(&root, &head_candidate)
        && native::is_within_dir(&root, &absolute_path);
    let Some(head_repo_path) =
        native::relative_inside(&root, &head_candidate).filter(|_| contained)
    else {
        return error(403, "File is outside the project");
    };

    let (committed, working) = tokio::join!(
        read_committed_blob(&root, &head_repo_path),
        read_working_file(&root, &absolute_path),
    );
    let committed = read_side(committed);
    let working = read_side(working);
    json(
        StatusCode::OK,
        &DiffResponse {
            path: file_path,
            original: committed.content,
            current: working.content,
            binary: committed.binary || working.binary,
            too_large: committed.too_large || working.too_large,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sides_flag_binary_before_size() {
        assert_eq!(read_side(None).content, None);
        assert_eq!(
            read_side(Some(b"text".to_vec())).content.as_deref(),
            Some("text")
        );
        assert!(read_side(Some(vec![0x89, 0x50, 0x00])).binary);
        let mut large = vec![b'a'; MAX_DIFF_BYTES + 1];
        assert!(read_side(Some(large.clone())).too_large);
        large[BINARY_SNIFF_BYTES + 1] = 0;
        assert!(read_side(Some(large.clone())).too_large);
        large[10] = 0;
        assert!(read_side(Some(large)).binary);
    }
}
