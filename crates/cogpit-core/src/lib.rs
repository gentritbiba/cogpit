//! `cogpit-core`: the Rust sidecar behind the TypeScript server.
//!
//! See `docs/architecture/rust-core.md` and the `core-protocol` crate for the
//! boot sequence and request contract.

mod auth;
mod diag;
mod routes;

use std::io;
use std::sync::Arc;
use std::time::Duration;

use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use core_protocol::{AppConfig, BootMessage, Handshake, PROTOCOL_VERSION};
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

/// How long open connections get to finish once stdin has closed.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Logs go to stderr, filtered by `COGPIT_CORE_LOG` (default `warn`).
pub fn init_logging() {
    let filter = tracing_subscriber::EnvFilter::try_from_env("COGPIT_CORE_LOG")
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(io::stderr)
        .with_ansi(false)
        .init();
}

/// Every route the core serves, behind the secret check.
pub fn app(secret: String, config: Arc<AppConfig>) -> Router {
    Router::new()
        .route("/v1/health", get(health))
        .merge(diag::router())
        .merge(routes::feature_routes(&config))
        .fallback(not_found)
        .layer(axum::middleware::from_fn_with_state(
            Arc::new(auth::Secret::new(secret)),
            auth::require_secret,
        ))
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "status": "ok", "version": VERSION, "protocol": PROTOCOL_VERSION }))
}

async fn not_found() -> impl IntoResponse {
    (StatusCode::NOT_FOUND, Json(json!({ "error": "Not found" })))
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

/// Read the boot line, listen, print the handshake, and serve until stdin closes.
pub async fn run() -> io::Result<()> {
    let mut stdin = BufReader::new(tokio::io::stdin());
    let mut line = String::new();
    if stdin.read_line(&mut line).await? == 0 {
        return Err(invalid("stdin closed before the boot message"));
    }
    let boot: BootMessage = serde_json::from_str(line.trim_end())
        .map_err(|error| invalid(format!("invalid boot message: {error}")))?;
    if boot.secret.is_empty() {
        return Err(invalid("the boot message has an empty secret"));
    }

    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let handshake = Handshake {
        port,
        version: VERSION.into(),
        protocol: PROTOCOL_VERSION,
    };
    let mut stdout = tokio::io::stdout();
    stdout
        .write_all(format!("{}\n", serde_json::to_string(&handshake)?).as_bytes())
        .await?;
    stdout.flush().await?;
    tracing::info!(port, "cogpit-core listening");

    let (closed_tx, closed_rx) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        // The parent holds our stdin open for as long as it wants us alive. EOF
        // (or a read error) means it is gone, on every platform.
        let mut sink = [0u8; 256];
        while matches!(stdin.read(&mut sink).await, Ok(n) if n > 0) {}
        let _ = closed_tx.send(());
    });

    let app = app(boot.secret, Arc::new(boot.config));
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    let mut server = tokio::spawn(async move {
        let mut stop_rx = stop_rx;
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = stop_rx.wait_for(|stop| *stop).await;
            })
            .await
    });

    tokio::select! {
        result = &mut server => return result.map_err(io::Error::other)?,
        _ = closed_rx => {}
    }
    tracing::info!("stdin closed, shutting down");
    let _ = stop_tx.send(true);
    let _ = tokio::time::timeout(SHUTDOWN_GRACE, server).await;
    Ok(())
}
