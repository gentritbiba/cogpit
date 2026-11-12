//! `GET file-content?path=`: a text file's contents for the viewers.

use axum::http::{HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};

use super::readable::{requested_path, validate_readable_file};
use crate::fsx::{blocking, lossy};
use crate::http::Failure;

const MAX_FILE_SIZE: u64 = 2 * 1024 * 1024;
const READ_FAILED: Failure = Failure(500, "Failed to read file");

pub async fn handler(uri: Uri) -> Response {
    let path = match requested_path(uri.query()) {
        Ok(path) => path,
        Err(failure) => return failure.respond(),
    };
    let read = blocking(move || {
        validate_readable_file(&path, MAX_FILE_SIZE)?;
        std::fs::read(&path).map(lossy).map_err(|_| READ_FAILED)
    })
    .await
    .unwrap_or(Err(READ_FAILED));
    let text = match read {
        Ok(text) => text,
        Err(failure) => return failure.respond(),
    };

    let mut response = (StatusCode::OK, text).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
}
