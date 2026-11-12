//! Gzip for single-shot JSON and text responses, the policy the TypeScript
//! server's `compressionMiddleware` applies to `/api`. Forwarded responses are
//! piped through TS untouched, so the core has to compress them itself.

use std::io::Write;

use axum::body::{Body, to_bytes};
use axum::extract::Request;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use flate2::Compression;
use flate2::write::GzEncoder;

/// Bodies smaller than this aren't worth the gzip overhead.
const MIN_COMPRESS_BYTES: usize = 1024;

/// Whether `Accept-Encoding` lists gzip without `q=0`.
pub fn accepts_gzip(headers: &HeaderMap) -> bool {
    let values: Vec<&str> = headers
        .get_all(header::ACCEPT_ENCODING)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .collect();
    values.join(",").split(',').any(|entry| {
        let mut parts = entry.trim().split(';');
        if !parts
            .next()
            .unwrap_or_default()
            .trim()
            .eq_ignore_ascii_case("gzip")
        {
            return false;
        }
        match parts.map(str::trim).find(|param| param.starts_with("q=")) {
            None => true,
            Some(quality) => quality[2..].trim().parse::<f64>().is_ok_and(|q| q > 0.0),
        }
    })
}

fn compressible(response: &Response) -> bool {
    let status = response.status();
    if status == StatusCode::NO_CONTENT || status == StatusCode::NOT_MODIFIED {
        return false;
    }
    if response.headers().contains_key(header::CONTENT_ENCODING) {
        return false;
    }
    response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|kind| {
            let kind = kind.to_ascii_lowercase();
            kind.starts_with("application/json") || kind.starts_with("text/")
        })
}

fn gzip(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(bytes).ok()?;
    encoder.finish().ok()
}

pub async fn layer(request: Request, next: Next) -> Response {
    let wants_gzip = request.method() != Method::HEAD && accepts_gzip(request.headers());
    let response = next.run(request).await;
    if !wants_gzip || !compressible(&response) {
        return response;
    }
    let (mut parts, body) = response.into_parts();
    let Ok(bytes) = to_bytes(body, usize::MAX).await else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    if bytes.len() < MIN_COMPRESS_BYTES {
        return Response::from_parts(parts, Body::from(bytes));
    }
    let source = bytes.clone();
    let Ok(Some(compressed)) = tokio::task::spawn_blocking(move || gzip(&source)).await else {
        return Response::from_parts(parts, Body::from(bytes));
    };
    let headers = &mut parts.headers;
    headers.insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
    headers.insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(compressed.len()));
    Response::from_parts(parts, Body::from(compressed))
}

#[cfg(test)]
mod tests {
    use super::accepts_gzip;
    use axum::http::{HeaderMap, HeaderValue, header};

    fn accepts(value: &str) -> bool {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ACCEPT_ENCODING,
            HeaderValue::from_str(value).unwrap(),
        );
        accepts_gzip(&headers)
    }

    #[test]
    fn gzip_acceptance_follows_the_typescript_parser() {
        assert!(accepts("gzip"));
        assert!(accepts("br, GZIP;q=0.5"));
        assert!(accepts("deflate, gzip"));
        assert!(!accepts("gzip;q=0"));
        assert!(!accepts("gzip;q=abc"));
        assert!(!accepts("br, deflate"));
        assert!(!accepts("*"));
        assert!(!accepts_gzip(&HeaderMap::new()));
    }
}
