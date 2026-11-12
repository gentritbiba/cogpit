//! Terminal sessions for the terminal panel and the scripts panel.
//!
//! The server terminates the panel's WebSocket at `/__pty`, authorizes every
//! frame, and relays each connection to [`router`]'s `/ws` as its own socket.
//! Frames pass through unchanged in both directions, so this crate speaks the
//! panel's protocol (`src/hooks/usePtySocket.ts`) and owns no auth. The server
//! resolves an agent's sign-in into a plain `command`/`args`/`env` spawn
//! before relaying it.

use std::sync::Arc;

use axum::Router;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use axum::routing::get;
use tokio::sync::mpsc;

mod backend;
mod protocol;
mod registry;
mod scrollback;
mod utf8;

use registry::Registry;

/// Every terminal session in the core, shared by all connections. A core
/// that exits without [`PtyState::shutdown`] still ends them: its exit closes
/// every PTY (SIGHUP to the session leader) and every job object.
#[derive(Clone, Default)]
pub struct PtyState {
    registry: Arc<Registry>,
}

impl PtyState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Kills every running terminal, as the server's shutdown always did.
    /// Blocks until the kills are sent.
    pub fn shutdown(&self) {
        self.registry.shutdown();
    }
}

pub fn router(state: PtyState) -> Router {
    Router::new().route("/ws", get(upgrade)).with_state(state)
}

async fn upgrade(State(state): State<PtyState>, upgrade: WebSocketUpgrade) -> Response {
    upgrade.on_upgrade(move |socket| serve(state.registry, socket))
}

async fn serve(registry: Arc<Registry>, mut socket: WebSocket) {
    let (outbox, mut frames) = mpsc::unbounded_channel();
    let client = registry.connect(outbox.clone());
    loop {
        tokio::select! {
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(text))) => registry.handle(client, &outbox, &text).await,
                Some(Ok(Message::Binary(bytes))) => {
                    registry.handle(client, &outbox, &String::from_utf8_lossy(&bytes)).await;
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                Some(Ok(Message::Close(_)) | Err(_)) | None => break,
            },
            Some(frame) = frames.recv() => {
                if socket.send(Message::Text(frame)).await.is_err() {
                    break;
                }
            }
        }
    }
    registry.disconnect(client);
}
