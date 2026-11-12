//! Transport self-test endpoints. The TS forwarder and WebSocket relay are
//! tested against these on the real binary, so they stay in every build.

use axum::body::Body;
use axum::extract::Request;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::http::{HeaderName, HeaderValue};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::{Json, Router};
use core_protocol::PRINCIPAL_HEADER;
use serde_json::json;

pub fn router() -> Router {
    Router::new()
        .route("/v1/diag/echo", any(echo))
        .route("/v1/diag/echo/{*rest}", any(echo))
        .route("/v1/diag/drain", any(drain))
        .route("/v1/diag/ws", get(ws_echo))
}

/// Streams the request body back as it arrives, and reports what reached the
/// core: method, path with query, and the principal header.
async fn echo(request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let mut response = Response::new(Body::from_stream(body.into_data_stream()));
    let headers = response.headers_mut();
    let seen = [
        ("x-core-method", parts.method.as_str().to_owned()),
        (
            "x-core-path",
            parts
                .uri
                .path_and_query()
                .map_or_else(String::new, |pq| pq.as_str().to_owned()),
        ),
        (
            "x-core-principal",
            parts
                .headers
                .get(PRINCIPAL_HEADER)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_owned(),
        ),
    ];
    for (name, value) in seen {
        if let Ok(value) = HeaderValue::from_str(&value) {
            headers.insert(HeaderName::from_static(name), value);
        }
    }
    if let Some(content_type) = parts.headers.get("content-type") {
        headers.insert("content-type", content_type.clone());
    }
    response
}

/// Reads the whole body before answering, like an upload route, and reports
/// its length.
async fn drain(body: Body) -> Response {
    match axum::body::to_bytes(body, usize::MAX).await {
        Ok(bytes) => Json(json!({ "bytes": bytes.len() })).into_response(),
        Err(_) => StatusCode::BAD_REQUEST.into_response(),
    }
}

/// Echoes every frame. A text frame `close:<code>:<reason>` closes the socket
/// with that code instead, so relays can be tested for code passthrough.
async fn ws_echo(upgrade: WebSocketUpgrade) -> impl IntoResponse {
    upgrade.on_upgrade(echo_socket)
}

async fn echo_socket(mut socket: WebSocket) {
    while let Some(Ok(message)) = socket.recv().await {
        let reply = match message {
            Message::Text(text) => match close_request(&text) {
                Some(frame) => {
                    let _ = socket.send(Message::Close(Some(frame))).await;
                    return;
                }
                None => Message::Text(text),
            },
            Message::Binary(bytes) => Message::Binary(bytes),
            Message::Close(_) => return,
            Message::Ping(_) | Message::Pong(_) => continue,
        };
        if socket.send(reply).await.is_err() {
            return;
        }
    }
}

fn close_request(text: &str) -> Option<CloseFrame> {
    let rest = text.strip_prefix("close:")?;
    let (code, reason) = rest.split_once(':').unwrap_or((rest, ""));
    Some(CloseFrame {
        code: code.parse().ok()?,
        reason: reason.to_owned().into(),
    })
}
