//! `GET local-file?path=`: images and videos for the timeline, with byte
//! ranges so a video element can seek.

use std::io::{Read, Seek, SeekFrom};
use std::time::UNIX_EPOCH;

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

/// A validator that changes whenever the file is rewritten, so an image an
/// agent re-takes at the same path is fetched again.
fn entity_tag(info: &std::fs::Metadata) -> String {
    let modified = info
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |since| since.as_nanos());
    format!("\"{:x}-{modified:x}\"", info.len())
}

/// Whether an `If-None-Match` list names `tag` (weak comparison) or `*`.
fn matches_any(header: &str, tag: &str) -> bool {
    header.split(',').map(str::trim).any(|candidate| {
        candidate == "*" || candidate.strip_prefix("W/").unwrap_or(candidate) == tag
    })
}

struct Conditions {
    range: Option<String>,
    if_none_match: Option<String>,
    if_range: Option<String>,
}

enum Opened {
    NotModified {
        tag: String,
    },
    Unsatisfiable {
        size: u64,
    },
    Serve {
        size: u64,
        range: ByteRange,
        length: u64,
        body: Body,
        tag: String,
    },
}

const READ_FAILED: Failure = Failure(500, "Failed to read file");

/// Check the file, open it at the range and read it, or set up the stream
/// for a long range. Blocks.
fn open_range(path: &str, max_size: u64, conditions: &Conditions) -> Result<Opened, Failure> {
    let info = validate_readable_file(path, max_size)?;
    let size = info.len();
    let tag = entity_tag(&info);
    if conditions
        .if_none_match
        .as_deref()
        .is_some_and(|header| matches_any(header, &tag))
    {
        return Ok(Opened::NotModified { tag });
    }
    // A range of a file that changed since the client's copy would splice
    // two versions together; `If-Range` asks for the whole file instead.
    let range_header = match conditions.if_range.as_deref() {
        Some(validator) if validator.trim() != tag => None,
        _ => conditions.range.as_deref(),
    };
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
        file.read_exact(&mut bytes)
            .map_err(|cause| READ_FAILED.because(cause))?;
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
        tag,
    })
}

fn header_text(headers: &HeaderMap, name: header::HeaderName) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

/// Revalidate on every use: one stat answers it, and a stale screenshot is
/// worse than a round trip.
const CACHE_CONTROL: HeaderValue = HeaderValue::from_static("private, no-cache");

fn validated(mut response: Response, tag: &str) -> Response {
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, CACHE_CONTROL);
    if let Ok(value) = HeaderValue::from_str(tag) {
        headers.insert(header::ETAG, value);
    }
    response
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
    let conditions = Conditions {
        range: header_text(&headers, header::RANGE),
        if_none_match: header_text(&headers, header::IF_NONE_MATCH),
        if_range: header_text(&headers, header::IF_RANGE),
    };
    let opened = blocking(move || open_range(&path, max_size, &conditions))
        .await
        .unwrap_or(Err(READ_FAILED));
    let (size, range, length, body, tag) = match opened {
        Ok(Opened::Serve {
            size,
            range,
            length,
            body,
            tag,
        }) => (size, range, length, body, tag),
        Ok(Opened::NotModified { tag }) => {
            return validated(StatusCode::NOT_MODIFIED.into_response(), &tag);
        }
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
    let mut response = validated((status, body).into_response(), &tag);
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
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
    fn if_none_match_lists_compare_weakly() {
        let tag = "\"5-a\"";
        assert!(matches_any("\"5-a\"", tag));
        assert!(matches_any("W/\"5-a\"", tag));
        assert!(matches_any("\"0-0\", \"5-a\"", tag));
        assert!(matches_any("*", tag));
        assert!(!matches_any("\"5-b\"", tag));
    }

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
