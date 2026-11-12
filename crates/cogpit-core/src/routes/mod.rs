//! Feature crates mount here, one line each, under `/v1/<area>`. Each crate
//! exposes `pub fn router(state) -> axum::Router` and owns no auth: the secret
//! check wraps everything, and TS authorized the caller before forwarding.

use std::sync::Arc;

use axum::Router;
use core_protocol::AppConfig;

pub fn feature_routes(_config: &Arc<AppConfig>) -> Router {
    Router::new()
}
