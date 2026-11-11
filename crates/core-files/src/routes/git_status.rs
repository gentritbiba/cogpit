//! `GET git-status?cwd=`: branch, divergence and changed files, with paths
//! relative to the requested cwd.

use axum::http::{StatusCode, Uri};
use axum::response::Response;
use serde::Serialize;

use crate::fsx::lossy;
use crate::git::{resolve_git_project, run_git};
use crate::http::{error, json, query_param};
use crate::paths::native;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusFile {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    pub index_status: String,
    pub work_tree_status: String,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u64,
    pub behind: u64,
    pub detached: bool,
}

fn count_after(detail: &str, label: &str) -> u64 {
    let Some(start) = detail.find(label) else {
        return 0;
    };
    let digits: String = detail[start + label.len()..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().unwrap_or(0)
}

fn non_empty(text: &str) -> Option<String> {
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

/// The `## branch...upstream [ahead N, behind M]` header of porcelain v1.
pub fn parse_branch_header(header: &str) -> BranchInfo {
    let value = header.strip_prefix("##").map_or(header, str::trim_start);
    if value == "HEAD (no branch)" {
        return BranchInfo {
            branch: None,
            upstream: None,
            ahead: 0,
            behind: 0,
            detached: true,
        };
    }

    let normalized = ["No commits yet on", "Initial commit on"]
        .iter()
        .find_map(|lead| {
            let rest = value.strip_prefix(lead)?;
            let trimmed = rest.trim_start();
            (trimmed.len() < rest.len()).then_some(trimmed)
        })
        .unwrap_or(value);
    let tracking = normalized.find("...");
    let detail_start = normalized.find(" [");
    let branch_end = tracking.or(detail_start).unwrap_or(normalized.len());
    let upstream_end = detail_start.unwrap_or(normalized.len());
    let upstream =
        tracking.and_then(|start| normalized.get(start + 3..upstream_end).and_then(non_empty));
    let detail = detail_start.map_or("", |start| &normalized[start..]);
    BranchInfo {
        branch: non_empty(&normalized[..branch_end]),
        upstream,
        ahead: count_after(detail, "ahead "),
        behind: count_after(detail, "behind "),
        detached: false,
    }
}

/// `git status --porcelain=v1 --branch -z` output.
pub fn parse_git_status(output: &str) -> (BranchInfo, Vec<StatusFile>) {
    let mut records = output.split('\0');
    let branch = parse_branch_header(records.next().unwrap_or_default());
    let mut files = Vec::new();
    while let Some(record) = records.next() {
        if record.len() < 3 || !(1..=3).all(|i| record.is_char_boundary(i)) {
            continue;
        }
        let index_status = &record[..1];
        let work_tree_status = &record[1..2];
        let renamed_or_copied = format!("{index_status}{work_tree_status}").contains(['R', 'C']);
        let original_path = if renamed_or_copied {
            records
                .next()
                .filter(|path| !path.is_empty())
                .map(str::to_owned)
        } else {
            None
        };
        files.push(StatusFile {
            path: record[3..].to_owned(),
            original_path,
            index_status: index_status.to_owned(),
            work_tree_status: work_tree_status.to_owned(),
        });
    }
    (branch, files)
}

/// Git prints paths relative to the repository root, but the panel works
/// relative to the requested cwd: strip the root-to-cwd prefix and drop
/// entries outside the cwd.
pub fn relativize_to_cwd(
    files: Vec<StatusFile>,
    root: &str,
    project_path: &str,
) -> Vec<StatusFile> {
    let Some(prefix) = native::relative_inside(root, project_path) else {
        return Vec::new();
    };
    if prefix.is_empty() {
        return files;
    }
    let strip = |path: &str| path.strip_prefix(&format!("{prefix}/")).map(str::to_owned);
    files
        .into_iter()
        .filter_map(|file| {
            Some(StatusFile {
                path: strip(&file.path)?,
                original_path: file.original_path.as_deref().and_then(strip),
                ..file
            })
        })
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryStatus {
    is_repository: bool,
    root: String,
    #[serde(flatten)]
    branch: BranchInfo,
    files: Vec<StatusFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NoRepository {
    is_repository: bool,
    files: [(); 0],
}

pub async fn handler(uri: Uri) -> Response {
    let cwd = query_param(uri.query(), "cwd").unwrap_or_default();
    let project = match resolve_git_project(&cwd).await {
        Ok(project) => project,
        Err(failure) => return failure.respond(),
    };
    let Some(root) = project.root else {
        return json(
            StatusCode::OK,
            &NoRepository {
                is_repository: false,
                files: [],
            },
        );
    };

    let args = [
        "-c",
        "color.status=false",
        "status",
        "--porcelain=v1",
        "--branch",
        "-z",
        "--untracked-files=all",
    ];
    let Ok(stdout) = run_git(&root, &args).await else {
        return error(500, "Unable to read git status");
    };
    let (branch, files) = parse_git_status(&lossy(stdout));
    json(
        StatusCode::OK,
        &RepositoryStatus {
            is_repository: true,
            files: relativize_to_cwd(files, &root, &project.project_path),
            root,
            branch,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, original: Option<&str>, index: &str, work_tree: &str) -> StatusFile {
        StatusFile {
            path: path.to_owned(),
            original_path: original.map(str::to_owned),
            index_status: index.to_owned(),
            work_tree_status: work_tree.to_owned(),
        }
    }

    #[test]
    fn parses_divergence_and_rename_records() {
        let (branch, files) = parse_git_status(
            "## feature...origin/feature [ahead 2, behind 1]\0R  src/new.ts\0src/old.ts\0 M README.md\0",
        );
        assert_eq!(
            branch,
            BranchInfo {
                branch: Some("feature".into()),
                upstream: Some("origin/feature".into()),
                ahead: 2,
                behind: 1,
                detached: false,
            }
        );
        assert_eq!(
            files,
            [
                file("src/new.ts", Some("src/old.ts"), "R", " "),
                file("README.md", None, " ", "M")
            ]
        );
    }

    #[test]
    fn parses_every_header_shape() {
        let header = |text: &str| parse_branch_header(text);
        assert!(header("## HEAD (no branch)").detached);
        assert_eq!(header("## main").branch.as_deref(), Some("main"));
        assert_eq!(header("## main").upstream, None);
        assert_eq!(
            header("## No commits yet on main").branch.as_deref(),
            Some("main")
        );
        assert_eq!(
            header("## Initial commit on dev").branch.as_deref(),
            Some("dev")
        );
        let behind = header("## main...origin/main [behind 3]");
        assert_eq!((behind.ahead, behind.behind), (0, 3));
        assert_eq!(behind.upstream.as_deref(), Some("origin/main"));
        let gone = header("## main...origin/main [gone]");
        assert_eq!(gone.upstream.as_deref(), Some("origin/main"));
        assert_eq!((gone.ahead, gone.behind), (0, 0));
        assert_eq!(header("").branch, None);
    }

    #[test]
    fn relativizes_paths_and_drops_entries_outside_the_cwd() {
        let files = vec![
            file("packages/app/src/index.ts", None, " ", "M"),
            file(
                "packages/app/renamed.ts",
                Some("packages/app/old.ts"),
                "R",
                " ",
            ),
            file("packages/other/file.ts", None, " ", "M"),
            file(
                "packages/app/moved-in.ts",
                Some("packages/other/out.ts"),
                "R",
                " ",
            ),
        ];
        let root = native::resolve(&["/repo"]);
        let nested = native::resolve(&[&root, "packages", "app"]);
        assert_eq!(
            relativize_to_cwd(files.clone(), &root, &nested),
            [
                file("src/index.ts", None, " ", "M"),
                file("renamed.ts", Some("old.ts"), "R", " "),
                file("moved-in.ts", None, "R", " "),
            ]
        );
        assert_eq!(relativize_to_cwd(files.clone(), &root, &root), files);
    }
}
