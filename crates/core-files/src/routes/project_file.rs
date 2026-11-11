//! `GET project-file` reads a UTF-8 project file for the editor; `PUT` saves
//! it atomically, refusing when the file changed on disk since it was read.

use std::fs::Metadata;

use axum::body::{Body, to_bytes};
use axum::http::{StatusCode, Uri};
use axum::response::Response;
use serde::Serialize;
use serde_json::Value;

use crate::fsx::{mtime_ms, realpath};
use crate::http::{Failure, JsNumber, json, query_param};
use crate::paths::native;

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// The server-wide request body ceiling (`MAX_REQUEST_BODY_BYTES`).
const MAX_REQUEST_BODY_BYTES: usize = 5 * 1024 * 1024;
const CONFLICT: &str = "File changed on disk. Reload it before saving.";

const UNEXPECTED: Failure = Failure(500, "Unable to access project file");

struct ProjectFile {
    absolute_path: String,
    info: Metadata,
}

async fn resolve_project_file(cwd: &str, file_path: &str) -> Result<ProjectFile, Failure> {
    if !native::is_absolute(cwd) {
        return Err(Failure(400, "cwd must be an absolute path"));
    }
    if file_path.is_empty() || native::is_absolute(file_path) || file_path.contains('\0') {
        return Err(Failure(400, "path must be a relative project file"));
    }
    let root = realpath(&native::resolve(&[cwd]))
        .await
        .map_err(|_| Failure(404, "Project directory not found"))?;

    let candidate = native::resolve(&[&root, file_path]);
    if !native::is_within_dir(&root, &candidate) {
        return Err(Failure(403, "File is outside the project"));
    }
    let absolute_path = realpath(&candidate)
        .await
        .map_err(|_| Failure(404, "File not found"))?;
    if !native::is_within_dir(&root, &absolute_path) {
        return Err(Failure(403, "File is outside the project"));
    }

    let info = tokio::fs::metadata(&absolute_path)
        .await
        .map_err(|_| UNEXPECTED)?;
    if !info.is_file() {
        return Err(Failure(400, "Path must point to a file"));
    }
    if info.len() > MAX_FILE_BYTES {
        return Err(Failure(413, "File is larger than 2 MB"));
    }
    Ok(ProjectFile {
        absolute_path,
        info,
    })
}

/// The editable text of a file: no NUL bytes, strict UTF-8, and the leading
/// byte-order mark dropped the way `TextDecoder` drops it.
fn decode_text_file(bytes: Vec<u8>) -> Result<String, Failure> {
    if bytes.contains(&0) {
        return Err(Failure(415, "Binary files cannot be edited"));
    }
    let text =
        String::from_utf8(bytes).map_err(|_| Failure(415, "File is not valid UTF-8 text"))?;
    Ok(match text.strip_prefix('\u{FEFF}') {
        Some(rest) => rest.to_owned(),
        None => text,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadResponse {
    content: String,
    mtime_ms: JsNumber,
    size: u64,
}

pub async fn read(uri: Uri) -> Response {
    let cwd = query_param(uri.query(), "cwd").unwrap_or_default();
    let path = query_param(uri.query(), "path").unwrap_or_default();
    let result = async {
        let file = resolve_project_file(&cwd, &path).await?;
        let bytes = tokio::fs::read(&file.absolute_path)
            .await
            .map_err(|_| UNEXPECTED)?;
        Ok::<_, Failure>(ReadResponse {
            content: decode_text_file(bytes)?,
            mtime_ms: JsNumber(mtime_ms(&file.info)),
            size: file.info.len(),
        })
    }
    .await;
    match result {
        Ok(body) => json(StatusCode::OK, &body),
        Err(failure) => failure.respond(),
    }
}

async fn current_mtime(path: &str) -> Result<f64, Failure> {
    let info = tokio::fs::metadata(path).await.map_err(|_| UNEXPECTED)?;
    Ok(mtime_ms(&info))
}

fn temporary_path(absolute_path: &str) -> String {
    let directory = native::resolve(&[absolute_path, ".."]);
    native::resolve(&[
        &directory,
        &format!(".{}.cogpit-save", uuid::Uuid::new_v4()),
    ])
}

async fn write_temporary(path: &str, content: &str, info: &Metadata) -> std::io::Result<()> {
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        options.mode(info.permissions().mode() & 0o7777);
    }
    #[cfg(not(unix))]
    let _ = info;
    let mut file = options.open(path).await?;
    tokio::io::AsyncWriteExt::write_all(&mut file, content.as_bytes()).await?;
    tokio::io::AsyncWriteExt::flush(&mut file).await
}

/// Write beside the file and rename over it, re-checking the mtime before
/// both steps. The temporary file never outlives the call.
async fn write_atomically(
    file: &ProjectFile,
    content: &str,
    expected_mtime_ms: f64,
) -> Result<(), Failure> {
    if current_mtime(&file.absolute_path).await? != expected_mtime_ms {
        return Err(Failure(409, CONFLICT));
    }
    let temporary = temporary_path(&file.absolute_path);
    let result = async {
        write_temporary(&temporary, content, &file.info)
            .await
            .map_err(|_| UNEXPECTED)?;
        if current_mtime(&file.absolute_path).await? != expected_mtime_ms {
            return Err(Failure(409, CONFLICT));
        }
        tokio::fs::rename(&temporary, &file.absolute_path)
            .await
            .map_err(|_| UNEXPECTED)
    }
    .await;
    let _ = tokio::fs::remove_file(&temporary).await;
    result
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveResponse {
    ok: bool,
    mtime_ms: JsNumber,
    size: u64,
}

pub async fn save(body: Body) -> Response {
    let result = async {
        let bytes = to_bytes(body, MAX_REQUEST_BODY_BYTES)
            .await
            .map_err(|_| UNEXPECTED)?;
        let body: Value = serde_json::from_slice(&bytes).map_err(|_| UNEXPECTED)?;
        if body.is_null() {
            return Err(UNEXPECTED);
        }
        let field = |name: &str| body.get(name);
        let (Some(Value::String(cwd)), Some(Value::String(path)), Some(Value::String(content))) =
            (field("cwd"), field("path"), field("content"))
        else {
            return Err(Failure(
                400,
                "cwd, path, content, and expectedMtimeMs are required",
            ));
        };
        let Some(expected_mtime_ms) = field("expectedMtimeMs").and_then(Value::as_f64) else {
            return Err(Failure(
                400,
                "cwd, path, content, and expectedMtimeMs are required",
            ));
        };
        if content.len() as u64 > MAX_FILE_BYTES {
            return Err(Failure(413, "File is larger than 2 MB"));
        }

        let file = resolve_project_file(cwd, path).await?;
        if mtime_ms(&file.info) != expected_mtime_ms {
            return Err(Failure(409, CONFLICT));
        }
        write_atomically(&file, content, expected_mtime_ms).await?;
        let saved = tokio::fs::metadata(&file.absolute_path)
            .await
            .map_err(|_| UNEXPECTED)?;
        Ok(SaveResponse {
            ok: true,
            mtime_ms: JsNumber(mtime_ms(&saved)),
            size: saved.len(),
        })
    }
    .await;
    match result {
        Ok(body) => json(StatusCode::OK, &body),
        Err(failure) => failure.respond(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_decoding_rejects_binary_and_invalid_utf8_and_drops_the_bom() {
        assert_eq!(
            decode_text_file(b"plain".to_vec()).ok().as_deref(),
            Some("plain")
        );
        assert_eq!(
            decode_text_file(b"\xEF\xBB\xBFbom".to_vec())
                .ok()
                .as_deref(),
            Some("bom")
        );
        assert_eq!(
            decode_text_file(b"a\0b".to_vec()).err().map(|f| f.0),
            Some(415)
        );
        assert_eq!(
            decode_text_file(b"\xFF".to_vec()).err().map(|f| f.1),
            Some("File is not valid UTF-8 text")
        );
    }
}
