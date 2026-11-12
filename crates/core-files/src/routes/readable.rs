//! The `?path=` contract shared by `local-file` and `file-content`.

use crate::http::{Failure, query_param};
use crate::paths::native;

/// The absolute path a request names, or the 400 it gets.
pub fn requested_path(query: Option<&str>) -> Result<String, Failure> {
    let path = query_param(query, "path").unwrap_or_default();
    if path.is_empty() {
        return Err(Failure(400, "path query parameter required"));
    }
    if !native::is_absolute(&path) {
        return Err(Failure(400, "path must be absolute"));
    }
    Ok(path)
}

/// The file's size when it is a regular file within `max_size`.
pub async fn validate_readable_file(path: &str, max_size: u64) -> Result<u64, Failure> {
    match tokio::fs::metadata(path).await {
        Ok(info) if !info.is_file() => Err(Failure(404, "Not a file")),
        Ok(info) if info.len() > max_size => Err(Failure(413, "File too large")),
        Ok(info) => Ok(info.len()),
        Err(_) => Err(Failure(404, "File not found")),
    }
}
