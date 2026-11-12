use std::sync::Arc;

use axum::Json;
use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use core_protocol::{PRINCIPAL_HEADER, SECRET_HEADER};
use serde_json::json;

pub struct Secret(Vec<u8>);

impl Secret {
    pub fn new(secret: String) -> Self {
        Self(secret.into_bytes())
    }

    /// Compares in time independent of where the first difference is.
    fn matches(&self, candidate: &[u8]) -> bool {
        if candidate.len() != self.0.len() {
            return false;
        }
        self.0
            .iter()
            .zip(candidate)
            .fold(0u8, |diff, (a, b)| diff | (a ^ b))
            == 0
    }
}

pub async fn require_secret(
    State(secret): State<Arc<Secret>>,
    request: Request,
    next: Next,
) -> Response {
    let presented = request.headers().get(SECRET_HEADER).map(|v| v.as_bytes());
    if !presented.is_some_and(|value| secret.matches(value)) {
        tracing::warn!(path = %request.uri().path(), "rejected a request without the core secret");
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Unauthorized" })),
        )
            .into_response();
    }
    let principal = request
        .headers()
        .get(PRINCIPAL_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("-");
    tracing::debug!(method = %request.method(), path = %request.uri().path(), principal, "request");
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::Secret;

    #[test]
    fn matches_only_the_exact_secret() {
        let secret = Secret::new("abc123".into());
        assert!(secret.matches(b"abc123"));
        assert!(!secret.matches(b"abc124"));
        assert!(!secret.matches(b"abc12"));
        assert!(!secret.matches(b""));
    }
}
