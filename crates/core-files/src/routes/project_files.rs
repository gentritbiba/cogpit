//! `GET project-files` (ranked search) and `GET project-files/tree` (one
//! directory at a time) over a cached, git-aware listing of the project.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::{StatusCode, Uri};
use axum::response::Response;
use serde::Serialize;

use crate::fsx::{locale_compare, realpath};
use crate::git::run_git;
use crate::http::{Failure, error, is_js_whitespace, js_number, json, query_param};
use crate::paths::native;

pub const MAX_FILES: usize = 20_000;
const CACHE_TTL: Duration = Duration::from_secs(30);
const IGNORED_DIRECTORIES: &[&str] = &[
    ".git",
    ".next",
    ".nuxt",
    ".output",
    ".turbo",
    ".vercel",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "target",
];

/// Listings by canonical project root, each kept for 30 s.
type Listing = Arc<Vec<String>>;

#[derive(Default)]
pub struct ListingCache {
    entries: Mutex<HashMap<String, (Instant, Listing)>>,
}

impl ListingCache {
    fn get(&self, root: &str) -> Option<Arc<Vec<String>>> {
        let entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        entries
            .get(root)
            .filter(|(expires_at, _)| *expires_at > Instant::now())
            .map(|(_, files)| Arc::clone(files))
    }

    fn set(&self, root: &str, files: Arc<Vec<String>>) {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        entries.insert(root.to_owned(), (Instant::now() + CACHE_TTL, files));
    }
}

fn sort_paths(files: &mut [String]) {
    files.sort_by(|a, b| locale_compare(a, b));
}

async fn list_git_files(root: &str) -> Option<Vec<String>> {
    let args = [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        ".",
    ];
    let stdout = run_git(root, &args).await.ok()?;
    let mut files: Vec<String> = stdout
        .split('\0')
        .filter(|path| !path.is_empty())
        .take(MAX_FILES)
        .map(str::to_owned)
        .collect();
    sort_paths(&mut files);
    Some(files)
}

/// Bounded walk for projects outside git: skips symlinks and build output.
fn walk_files(root: &str) -> Vec<String> {
    let mut files = Vec::new();
    let mut pending = vec![String::new()];
    'walk: while let Some(relative) = pending.pop() {
        let directory = if relative.is_empty() {
            root.to_owned()
        } else {
            native::resolve(&[root, &relative])
        };
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            let path = if relative.is_empty() {
                name.clone()
            } else {
                format!("{relative}/{name}")
            };
            if kind.is_dir() {
                if !IGNORED_DIRECTORIES.contains(&name.as_str()) {
                    pending.push(path);
                }
                continue;
            }
            if !kind.is_file() {
                continue;
            }
            files.push(path);
            if files.len() >= MAX_FILES {
                break 'walk;
            }
        }
    }
    sort_paths(&mut files);
    files
}

/// Every project file, relative with `/` separators, sorted.
pub async fn list_project_files(
    cache: &ListingCache,
    root: &str,
    skip_cache: bool,
) -> Arc<Vec<String>> {
    if !skip_cache && let Some(files) = cache.get(root) {
        return files;
    }
    let files = match list_git_files(root).await {
        Some(files) => files,
        None => {
            let root = root.to_owned();
            tokio::task::spawn_blocking(move || walk_files(&root))
                .await
                .unwrap_or_default()
        }
    };
    let files = Arc::new(files);
    cache.set(root, Arc::clone(&files));
    files
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct TreeEntry {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: &'static str,
}

struct Children {
    directories: Vec<String>,
    files: Vec<String>,
}

/// Names in first-seen order without repeats, like iterating a JS `Set`.
#[derive(Default)]
struct OrderedNames<'a> {
    seen: HashSet<&'a str>,
    names: Vec<&'a str>,
}

impl<'a> OrderedNames<'a> {
    fn insert(&mut self, name: &'a str) {
        if self.seen.insert(name) {
            self.names.push(name);
        }
    }
}

/// Names one level below `prefix`, each group sorted. Names that collate as
/// equal (`é` and `e\u{301}`) keep listing order, as the stable JS sort does.
fn direct_children(files: &[String], prefix: &str) -> Children {
    let mut directories = OrderedNames::default();
    let mut plain_files = OrderedNames::default();
    for file in files {
        let Some(rest) = file.strip_prefix(prefix) else {
            continue;
        };
        match rest.split_once('/') {
            None => plain_files.insert(rest),
            Some((directory, _)) => directories.insert(directory),
        }
    }
    let sorted = |names: OrderedNames| {
        let mut names: Vec<String> = names.names.into_iter().map(str::to_owned).collect();
        sort_paths(&mut names);
        names
    };
    Children {
        directories: sorted(directories),
        files: sorted(plain_files),
    }
}

fn compact_chain(files: &[String], prefix: &str, name: &str) -> String {
    let mut chain = name.to_owned();
    loop {
        let children = direct_children(files, &format!("{prefix}{chain}/"));
        if !children.files.is_empty() || children.directories.len() != 1 {
            return chain;
        }
        chain = format!("{chain}/{}", children.directories[0]);
    }
}

/// Direct children of `directory` (project-relative, `""` for the root):
/// directories first, and a directory whose only child is another directory
/// is reported as one entry named with the whole chain (`src/components/ui`).
pub fn list_directory_entries(files: &[String], directory: &str) -> Vec<TreeEntry> {
    let trimmed = directory.trim_end_matches('/');
    let prefix = if trimmed.is_empty() {
        String::new()
    } else {
        format!("{trimmed}/")
    };
    let children = direct_children(files, &prefix);
    let directories = children.directories.iter().map(|name| TreeEntry {
        name: compact_chain(files, &prefix, name),
        kind: "directory",
    });
    let plain = children
        .files
        .into_iter()
        .map(|name| TreeEntry { name, kind: "file" });
    directories.chain(plain).collect()
}

fn match_score(lower_path: &str, basename: &str, normalized: &str) -> u8 {
    if basename == normalized || basename.starts_with(&format!("{normalized}.")) {
        0
    } else if basename.starts_with(normalized) {
        1
    } else if lower_path.starts_with(normalized) {
        2
    } else if basename.contains(normalized) {
        3
    } else {
        4
    }
}

pub struct Ranked {
    /// The highest-ranked matches, capped at `limit`.
    pub files: Vec<String>,
    /// How many files matched before `limit` was applied.
    pub total_matches: usize,
}

/// Rank by basename match, then depth, then length (in UTF-16 units, as JS
/// measures it). The sort is stable, so ties keep listing order.
pub fn rank_project_files(files: &[String], query: &str, limit: usize) -> Ranked {
    let normalized = query.trim_matches(is_js_whitespace).to_lowercase();
    if normalized.is_empty() {
        return Ranked {
            files: files.iter().take(limit).cloned().collect(),
            total_matches: files.len(),
        };
    }
    let terms: Vec<&str> = normalized
        .split(is_js_whitespace)
        .filter(|term| !term.is_empty())
        .collect();

    let mut matches: Vec<(u8, usize, usize, &String)> = files
        .iter()
        .filter_map(|path| {
            let lower = path.to_lowercase();
            if !terms.iter().all(|term| lower.contains(term)) {
                return None;
            }
            let basename = lower.rsplit('/').next().unwrap_or(&lower);
            let score = match_score(&lower, basename, &normalized);
            Some((
                score,
                path.split('/').count(),
                path.encode_utf16().count(),
                path,
            ))
        })
        .collect();
    matches.sort_by_key(|(score, depth, length, _)| (*score, *depth, *length));

    Ranked {
        total_matches: matches.len(),
        files: matches
            .into_iter()
            .take(limit)
            .map(|(.., path)| path.clone())
            .collect(),
    }
}

/// The canonical project root for `cwd`, or the error response.
async fn resolve_project_root(cwd: &str) -> Result<String, Failure> {
    if !native::is_absolute(cwd) {
        return Err(Failure(400, "cwd must be an absolute path"));
    }
    let resolved = native::resolve(&[cwd]);
    match tokio::fs::metadata(&resolved).await {
        Ok(info) if !info.is_dir() => return Err(Failure(400, "cwd must be a directory")),
        Ok(_) => {}
        Err(_) => return Err(Failure(404, "Project directory not found")),
    }
    realpath(&resolved)
        .await
        .map_err(|_| Failure(404, "Project directory not found"))
}

/// `Math.min(Math.max(Number(limit) || 30, 1), 100)`, truncated as `slice` does.
fn result_limit(text: Option<&str>) -> usize {
    let requested = js_number(text.unwrap_or_default());
    let requested = if requested.is_nan() || requested == 0.0 {
        30.0
    } else {
        requested
    };
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let limit = requested.clamp(1.0, 100.0) as usize;
    limit
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ListResponse {
    files: Vec<String>,
    total_matches: usize,
    scan_limited: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TreeResponse {
    entries: Vec<TreeEntry>,
    scan_limited: bool,
}

pub async fn list(State(cache): State<Arc<ListingCache>>, uri: Uri) -> Response {
    let query = uri.query();
    let search = query_param(query, "q").unwrap_or_default();
    let limit = result_limit(query_param(query, "limit").as_deref());
    let skip_cache = query_param(query, "refresh").as_deref() == Some("1");

    let root = match resolve_project_root(&query_param(query, "cwd").unwrap_or_default()).await {
        Ok(root) => root,
        Err(failure) => return failure.respond(),
    };
    let files = list_project_files(&cache, &root, skip_cache).await;
    let ranked = rank_project_files(&files, &search, limit);
    json(
        StatusCode::OK,
        &ListResponse {
            files: ranked.files,
            total_matches: ranked.total_matches,
            scan_limited: files.len() >= MAX_FILES,
        },
    )
}

pub async fn tree(State(cache): State<Arc<ListingCache>>, uri: Uri) -> Response {
    let query = uri.query();
    let directory = query_param(query, "dir").unwrap_or_default();
    let directory = directory.trim_matches('/');
    if directory.split('/').any(|segment| segment == "..") {
        return error(400, "dir must stay inside the project");
    }
    let root = match resolve_project_root(&query_param(query, "cwd").unwrap_or_default()).await {
        Ok(root) => root,
        Err(failure) => return failure.respond(),
    };
    let skip_cache = query_param(query, "refresh").as_deref() == Some("1");
    let files = list_project_files(&cache, &root, skip_cache).await;
    json(
        StatusCode::OK,
        &TreeResponse {
            entries: list_directory_entries(&files, directory),
            scan_limited: files.len() >= MAX_FILES,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owned(files: &[&str]) -> Vec<String> {
        files.iter().map(|file| (*file).to_owned()).collect()
    }

    fn entry(name: &str, kind: &'static str) -> TreeEntry {
        TreeEntry {
            name: name.to_owned(),
            kind,
        }
    }

    #[test]
    fn ranking_prefers_basename_prefixes_and_counts_every_match() {
        let files = owned(&[
            "src/components/Button.tsx",
            "src/components/Button.test.tsx",
            "src/lib/button-utils.ts",
            "README.md",
        ]);
        let ranked = rank_project_files(&files, "button", 2);
        assert_eq!(
            ranked.files,
            [
                "src/components/Button.tsx",
                "src/components/Button.test.tsx"
            ]
        );
        assert_eq!(ranked.total_matches, 3);
        assert_eq!(rank_project_files(&files, "button", 10).total_matches, 3);
        assert_eq!(
            rank_project_files(&files, "src utils", 10).files,
            ["src/lib/button-utils.ts"]
        );
        assert_eq!(rank_project_files(&files, "", 2).total_matches, 4);
        assert_eq!(rank_project_files(&files, "", 2).files.len(), 2);
        assert_eq!(
            rank_project_files(&files, "nothing-matches", 10).total_matches,
            0
        );
    }

    #[test]
    fn tree_lists_directories_first_and_compacts_chains() {
        let files = owned(&[
            "src/components/Button.tsx",
            "src/components/ui/dialog.tsx",
            "src/index.ts",
            "README.md",
            ".gitignore",
        ]);
        assert_eq!(
            list_directory_entries(&files, ""),
            [
                entry("src", "directory"),
                entry(".gitignore", "file"),
                entry("README.md", "file")
            ]
        );
        assert_eq!(
            list_directory_entries(&files, "src/components"),
            [entry("ui", "directory"), entry("Button.tsx", "file")]
        );
        assert_eq!(
            list_directory_entries(&files, "src/components/"),
            list_directory_entries(&files, "src/components")
        );
        let chain = owned(&[
            "packages/app/src/index.ts",
            "packages/app/src/lib/a.ts",
            "top.ts",
        ]);
        assert_eq!(
            list_directory_entries(&chain, ""),
            [
                entry("packages/app/src", "directory"),
                entry("top.ts", "file")
            ]
        );
        assert_eq!(
            list_directory_entries(&chain, "packages/app/src"),
            [entry("lib", "directory"), entry("index.ts", "file")]
        );
        assert_eq!(
            list_directory_entries(&owned(&["src/a.ts", "src-legacy/b.ts"]), "src"),
            [entry("a.ts", "file")]
        );
        let equal = owned(&["\u{e9}/a.ts", "e\u{301}/z.ts"]);
        assert_eq!(
            list_directory_entries(&equal, ""),
            [entry("\u{e9}", "directory"), entry("e\u{301}", "directory")]
        );
    }

    #[test]
    fn limit_follows_the_typescript_clamp() {
        assert_eq!(result_limit(None), 30);
        assert_eq!(result_limit(Some("0")), 30);
        assert_eq!(result_limit(Some("abc")), 30);
        assert_eq!(result_limit(Some("2.9")), 2);
        assert_eq!(result_limit(Some("-4")), 1);
        assert_eq!(result_limit(Some("500")), 100);
        assert_eq!(result_limit(Some("Infinity")), 100);
    }
}
