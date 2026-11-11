//! `GET file-content?path=`: a text file's contents for the viewers.

use axum::http::{HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};

use super::readable::{requested_path, validate_readable_file};
use crate::fsx::lossy;
use crate::http::error;

const MAX_FILE_SIZE: u64 = 2 * 1024 * 1024;

pub async fn handler(uri: Uri) -> Response {
    let path = match requested_path(uri.query()) {
        Ok(path) => path,
        Err(failure) => return failure.respond(),
    };
    if let Err(failure) = validate_readable_file(&path, MAX_FILE_SIZE).await {
        return failure.respond();
    }
    let Ok(bytes) = tokio::fs::read(&path).await else {
        return error(500, "Failed to read file");
    };

    let mut response = (StatusCode::OK, lossy(bytes)).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
}
