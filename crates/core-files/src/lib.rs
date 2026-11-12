//! Files and git routes for `cogpit-core`: local media with byte ranges, file
//! contents, the project file listing, editing a project file, and git
//! status/diff. The TypeScript server authorizes each request and forwards it
//! here; this crate does no auth of its own.

mod compress;
mod fsx;
mod git;
mod http;
mod media;
pub mod paths;
pub mod routes;

use std::sync::Arc;

use axum::Router;
use axum::routing::get;

use routes::project_files::ListingCache;
use routes::{file_content, git_diff, git_status, local_file, project_file, project_files};

/// State the routes share: the 30-second project listing cache.
#[derive(Clone, Default)]
pub struct FilesState {
    listing: Arc<ListingCache>,
}

/// The files and git routes, relative to wherever the core mounts them.
pub fn router(state: FilesState) -> Router {
    Router::new()
        .route("/local-file", get(local_file::handler))
        .route("/file-content", get(file_content::handler))
        .route("/project-files", get(project_files::list))
        .route("/project-files/tree", get(project_files::tree))
        .route(
            "/project-file",
            get(project_file::read).put(project_file::save),
        )
        .route("/git-status", get(git_status::handler))
        .route("/git-diff", get(git_diff::handler))
        .with_state(state.listing)
        .layer(axum::middleware::from_fn(compress::layer))
}
