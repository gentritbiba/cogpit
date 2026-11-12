//! Feature crates mount here, one line each, under `/v1/<area>`. Each crate
//! exposes `pub fn router(state) -> axum::Router` and owns no auth: the secret
//! check wraps everything, and TS authorized the caller before forwarding.

use std::sync::Arc;

use axum::Router;
use core_pty::PtyState;
use core_protocol::AppConfig;

/// The feature crates' state, kept for the core's lifetime.
#[derive(Clone)]
pub struct Features {
    pty: PtyState,
}

impl Features {
    pub fn new(_config: &Arc<AppConfig>) -> Self {
        Self {
            pty: PtyState::new(),
        }
    }

    pub fn router(&self) -> Router {
        Router::new()
            .nest(
                "/v1/files",
                core_files::router(core_files::FilesState::default()),
            )
            .nest("/v1/pty", core_pty::router(self.pty.clone()))
    }

    /// What the features do when the core is asked to stop. Blocks.
    pub fn shutdown(&self) {
        self.pty.shutdown();
    }
}
