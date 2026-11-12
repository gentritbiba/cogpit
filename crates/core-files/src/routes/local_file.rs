//! `GET local-file?path=`: images and videos for the timeline, with byte
//! ranges so a video element can seek.

use std::io::{Read, Seek, SeekFrom};

use axum::body::Body;
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use tokio::io::AsyncReadExt;
use tokio_util::io::ReaderStream;

use super::readable::{requested_path, validate_readable_file};
use crate::fsx::blocking;
use crate::http::{Failure, error};
use crate::media::{image_type, video_type};
use crate::paths::native;

/// Read size per streamed chunk, as Node read streams use.
const STREAM_CHUNK: usize = 64 * 1024;
/// Images and seeks up to this size are read in one go rather than streamed
/// chunk by chunk, each chunk a trip to the blocking pool.
const WHOLE_READ_BYTES: u64 = 1024 * 1024;
const MAX_IMAGE_SIZE: u64 = 50 * 1024 * 1024;
/// Videos are served in ranges, so only a sanity ceiling applies.
const MAX_VIDEO_SIZE: u64 = 1024 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum ByteRange {
    Whole,
    Part { start: u64, end: u64 },
    Unsatisfiable,
}

fn parse_digits(text: &str) -> u64 {
    text.parse().unwrap_or(u64::MAX)
}

/// Parse a single `bytes=start-end` header against the file size.
pub fn parse_range(header: Option<&str>, size: u64) -> ByteRange {
    let Some(header) = header else {
        return ByteRange::Whole;
    };
    let Some(spec) = header.trim().strip_prefix("bytes=") else {
        return ByteRange::Whole;
    };
    let Some((start_text, end_text)) = spec.split_once('-') else {
        return ByteRange::Whole;
    };
    let digits = |text: &str| text.bytes().all(|b| b.is_ascii_digit());
    if !digits(start_text) || !digits(end_text) || (start_text.is_empty() && end_text.is_empty()) {
        return ByteRange::Whole;
    }

    if start_text.is_empty() {
        let suffix = parse_digits(end_text).min(size);
        return if suffix == 0 {
            ByteRange::Unsatisfiable
        } else {
            ByteRange::Part {
                start: size - suffix,
                end: size - 1,
            }
        };
    }

    let start = parse_digits(start_text);
    let end = if end_text.is_empty() {
        size.saturating_sub(1)
    } else {
        parse_digits(end_text).min(size.saturating_sub(1))
    };
    if start >= size || start > end {
        return ByteRange::Unsatisfiable;
    }
    ByteRange::Part { start, end }
}

enum Opened {
    Unsatisfiable {
        size: u64,
    },
    Serve {
        size: u64,
        range: ByteRange,
        length: u64,
        body: Body,
    },
}

const READ_FAILED: Failure = Failure(500, "Failed to read file");

/// Check the file, open it at the range and read it, or set up the stream
/// for a long range. Blocks.
fn open_range(path: &str, max_size: u64, range_header: Option<&str>) -> Result<Opened, Failure> {
    let size = validate_readable_file(path, max_size)?;
    let range = parse_range(range_header, size);
    let (start, length) = match range {
        ByteRange::Unsatisfiable => return Ok(Opened::Unsatisfiable { size }),
        ByteRange::Part { start, end } => (start, end - start + 1),
        ByteRange::Whole => (0, size),
    };

    let not_found = |_| Failure(404, "File not found");
    let mut file = std::fs::File::open(path).map_err(not_found)?;
    if start > 0 {
        file.seek(SeekFrom::Start(start)).map_err(not_found)?;
    }
    let body = if length <= WHOLE_READ_BYTES {
        let mut bytes = vec![0; usize::try_from(length).unwrap_or_default()];
        // A file that shrank since it was measured fails here rather than
        // answering with fewer bytes than its Content-Length.
        file.read_exact(&mut bytes).map_err(|_| READ_FAILED)?;
        Body::from(bytes)
    } else {
        let file = tokio::fs::File::from_std(file).take(length);
        Body::from_stream(ReaderStream::with_capacity(file, STREAM_CHUNK))
    };
    Ok(Opened::Serve {
        size,
        range,
        length,
        body,
    })
}

pub async fn handler(uri: Uri, headers: HeaderMap) -> Response {
    let path = match requested_path(uri.query()) {
        Ok(path) => path,
        Err(failure) => return failure.respond(),
    };

    let extension = native::extname(&path).to_lowercase();
    let (content_type, max_size) = match (image_type(&extension), video_type(&extension)) {
        (Some(image), _) => (image, MAX_IMAGE_SIZE),
        (None, Some(video)) => (video, MAX_VIDEO_SIZE),
        (None, None) => return error(403, "Only image and video files are allowed"),
    };
    let range_header = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let opened = blocking(move || open_range(&path, max_size, range_header.as_deref()))
        .await
        .unwrap_or(Err(READ_FAILED));
    let (size, range, length, body) = match opened {
        Ok(Opened::Serve {
            size,
            range,
            length,
            body,
        }) => (size, range, length, body),
        Ok(Opened::Unsatisfiable { size }) => {
            let mut response = error(416, "Range not satisfiable");
            if let Ok(value) = HeaderValue::from_str(&format!("bytes */{size}")) {
                response.headers_mut().insert(header::CONTENT_RANGE, value);
            }
            return response;
        }
        Err(failure) => return failure.respond(),
    };

    let status = match range {
        ByteRange::Part { .. } => StatusCode::PARTIAL_CONTENT,
        _ => StatusCode::OK,
    };
    let mut response = (status, body).into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=3600"),
    );
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    if let ByteRange::Part { start, end } = range
        && let Ok(value) = HeaderValue::from_str(&format!("bytes {start}-{end}/{size}"))
    {
        headers.insert(header::CONTENT_RANGE, value);
    }
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges_follow_the_typescript_parser() {
        assert_eq!(parse_range(None, 5), ByteRange::Whole);
        assert_eq!(
            parse_range(Some("bytes=2-3"), 5),
            ByteRange::Part { start: 2, end: 3 }
        );
        assert_eq!(
            parse_range(Some("bytes=2-"), 5),
            ByteRange::Part { start: 2, end: 4 }
        );
        assert_eq!(
            parse_range(Some("bytes=-2"), 5),
            ByteRange::Part { start: 3, end: 4 }
        );
        assert_eq!(
            parse_range(Some("bytes=-9"), 5),
            ByteRange::Part { start: 0, end: 4 }
        );
        assert_eq!(
            parse_range(Some("bytes=2-99"), 5),
            ByteRange::Part { start: 2, end: 4 }
        );
        assert_eq!(
            parse_range(Some(" bytes=0-0 "), 5),
            ByteRange::Part { start: 0, end: 0 }
        );
        assert_eq!(parse_range(Some("bytes=9-12"), 5), ByteRange::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=3-2"), 5), ByteRange::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=-0"), 5), ByteRange::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=0-"), 0), ByteRange::Unsatisfiable);
        assert_eq!(
            parse_range(Some("bytes=99999999999999999999999-"), 5),
            ByteRange::Unsatisfiable
        );
        assert_eq!(parse_range(Some("bytes=-"), 5), ByteRange::Whole);
        assert_eq!(parse_range(Some("bytes=0-1,3-4"), 5), ByteRange::Whole);
        assert_eq!(parse_range(Some("items=0-1"), 5), ByteRange::Whole);
        assert_eq!(parse_range(Some("bytes=a-1"), 5), ByteRange::Whole);
    }
}
