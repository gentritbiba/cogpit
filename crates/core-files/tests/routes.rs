//! The TypeScript route tests' expectations, run against the Rust router with
//! real files and a real `git`.

use std::path::Path;
use std::process::Command;

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Method, Request, StatusCode};
use core_files::{FilesState, router};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    body: Vec<u8>,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).expect("JSON body")
    }

    fn text(&self) -> String {
        String::from_utf8(self.body.clone()).expect("UTF-8 body")
    }

    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|value| value.to_str().ok())
    }
}

async fn send(app: &Router, request: Request<Body>) -> Reply {
    let response = app.clone().oneshot(request).await.expect("router answers");
    let status = response.status();
    let headers = response.headers().clone();
    let body = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes()
        .to_vec();
    Reply {
        status,
        headers,
        body,
    }
}

fn encode(value: &str) -> String {
    form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn query(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(key, value)| format!("{key}={}", encode(value)))
        .collect::<Vec<_>>()
        .join("&")
}

async fn get(app: &Router, route: &str, pairs: &[(&str, &str)]) -> Reply {
    get_with(app, route, pairs, None).await
}

async fn get_with(app: &Router, route: &str, pairs: &[(&str, &str)], range: Option<&str>) -> Reply {
    let mut request = Request::get(format!("{route}?{}", query(pairs)));
    if let Some(range) = range {
        request = request.header("range", range);
    }
    send(app, request.body(Body::empty()).unwrap()).await
}

async fn put_json(app: &Router, route: &str, body: &str) -> Reply {
    let request = Request::builder()
        .method(Method::PUT)
        .uri(route)
        .header("content-type", "application/json")
        .body(Body::from(body.to_owned()))
        .unwrap();
    send(app, request).await
}

/// Keys appear in the same order `JSON.stringify` wrote them.
fn assert_key_order(text: &str, keys: &[&str]) {
    let positions: Vec<usize> = keys
        .iter()
        .map(|key| {
            text.find(&format!("\"{key}\":"))
                .unwrap_or_else(|| panic!("{key} in {text}"))
        })
        .collect();
    assert!(positions.windows(2).all(|pair| pair[0] < pair[1]), "{text}");
}

fn app() -> Router {
    router(FilesState::default())
}

fn path_str(path: &Path) -> &str {
    path.to_str().expect("UTF-8 temp path")
}

fn write(path: &Path, content: impl AsRef<[u8]>) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, content).unwrap();
}

fn git(root: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args([
            "-c",
            "user.name=Cogpit Test",
            "-c",
            "user.email=test@example.com",
        ])
        .args(args)
        .current_dir(root)
        .output()
        .expect("git runs");
    assert!(
        status.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&status.stderr)
    );
}

fn repository() -> TempDir {
    let dir = TempDir::new().unwrap();
    git(dir.path(), &["init", "-q", "-b", "main"]);
    dir
}

fn commit_all(root: &Path, message: &str) {
    git(root, &["add", "-A"]);
    git(root, &["commit", "-q", "-m", message]);
}

// ── local-file ──────────────────────────────────────────────────────────

#[tokio::test]
async fn local_file_streams_an_image_with_its_headers() {
    let dir = TempDir::new().unwrap();
    let image = dir.path().join("image.png");
    write(&image, "image");

    let reply = get(&app(), "/local-file", &[("path", path_str(&image))]).await;

    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.header("content-type"), Some("image/png"));
    assert_eq!(reply.header("content-length"), Some("5"));
    assert_eq!(reply.header("accept-ranges"), Some("bytes"));
    assert_eq!(reply.header("cache-control"), Some("private, max-age=3600"));
    assert_eq!(reply.header("content-range"), None);
    assert_eq!(reply.text(), "image");
}

#[tokio::test]
async fn local_file_streams_videos_and_matches_extensions_case_insensitively() {
    let dir = TempDir::new().unwrap();
    let video = dir.path().join("recording.MP4");
    write(&video, "video");

    let reply = get(&app(), "/local-file", &[("path", path_str(&video))]).await;

    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.header("content-type"), Some("video/mp4"));
    assert_eq!(reply.text(), "video");
}

#[tokio::test]
async fn local_file_serves_byte_ranges_so_videos_seek() {
    let dir = TempDir::new().unwrap();
    let video = dir.path().join("recording.webm");
    write(&video, "video");
    let app = app();
    let path = [("path", path_str(&video))];

    let part = get_with(&app, "/local-file", &path, Some("bytes=2-3")).await;
    assert_eq!(part.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(part.header("content-range"), Some("bytes 2-3/5"));
    assert_eq!(part.header("content-length"), Some("2"));
    assert_eq!(part.header("content-type"), Some("video/webm"));
    assert_eq!(part.text(), "de");

    let open = get_with(&app, "/local-file", &path, Some("bytes=2-")).await;
    assert_eq!(open.header("content-range"), Some("bytes 2-4/5"));
    assert_eq!(open.text(), "deo");

    let suffix = get_with(&app, "/local-file", &path, Some("bytes=-2")).await;
    assert_eq!(suffix.header("content-range"), Some("bytes 3-4/5"));
    assert_eq!(suffix.text(), "eo");

    let past = get_with(&app, "/local-file", &path, Some("bytes=9-12")).await;
    assert_eq!(past.status, StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(past.header("content-range"), Some("bytes */5"));
    assert_eq!(past.header("content-type"), Some("application/json"));
    assert_eq!(past.json(), json!({ "error": "Range not satisfiable" }));
}

#[tokio::test]
async fn local_file_allows_videos_larger_than_the_image_ceiling() {
    let dir = TempDir::new().unwrap();
    let video = dir.path().join("large.mp4");
    let image = dir.path().join("large.png");
    for path in [&video, &image] {
        std::fs::File::create(path)
            .unwrap()
            .set_len(60 * 1024 * 1024)
            .unwrap();
    }
    let app = app();

    let video_reply = get_with(
        &app,
        "/local-file",
        &[("path", path_str(&video))],
        Some("bytes=0-0"),
    )
    .await;
    assert_eq!(video_reply.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        video_reply.header("content-range"),
        Some("bytes 0-0/62914560")
    );

    let image_reply = get(&app, "/local-file", &[("path", path_str(&image))]).await;
    assert_eq!(image_reply.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(image_reply.json(), json!({ "error": "File too large" }));
}

#[tokio::test]
async fn local_file_rejects_requests_it_must_not_serve() {
    let dir = TempDir::new().unwrap();
    let text = dir.path().join("notes.txt");
    write(&text, "secret");
    let app = app();

    let not_media = get(&app, "/local-file", &[("path", path_str(&text))]).await;
    assert_eq!(not_media.status, StatusCode::FORBIDDEN);
    assert_eq!(
        not_media.json(),
        json!({ "error": "Only image and video files are allowed" })
    );

    let missing = get(
        &app,
        "/local-file",
        &[("path", path_str(&dir.path().join("gone.png")))],
    )
    .await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
    assert_eq!(missing.json(), json!({ "error": "File not found" }));

    let folder = dir.path().join("folder.png");
    std::fs::create_dir(&folder).unwrap();
    let directory = get(&app, "/local-file", &[("path", path_str(&folder))]).await;
    assert_eq!(directory.status, StatusCode::NOT_FOUND);
    assert_eq!(directory.json(), json!({ "error": "Not a file" }));

    let relative = get(&app, "/local-file", &[("path", "image.png")]).await;
    assert_eq!(relative.status, StatusCode::BAD_REQUEST);
    assert_eq!(relative.json(), json!({ "error": "path must be absolute" }));

    let absent = get(&app, "/local-file", &[]).await;
    assert_eq!(absent.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        absent.json(),
        json!({ "error": "path query parameter required" })
    );
}

// ── file-content ────────────────────────────────────────────────────────

#[tokio::test]
async fn file_content_returns_text_with_non_cacheable_headers() {
    let dir = TempDir::new().unwrap();
    let notes = dir.path().join("notes.txt");
    write(&notes, b"hello \xFF\n");

    let reply = get(&app(), "/file-content", &[("path", path_str(&notes))]).await;

    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(
        reply.header("content-type"),
        Some("text/plain; charset=utf-8")
    );
    assert_eq!(reply.header("cache-control"), Some("no-cache"));
    assert_eq!(reply.text(), "hello \u{FFFD}\n");
}

#[tokio::test]
async fn file_content_validates_its_path_and_size() {
    let dir = TempDir::new().unwrap();
    let large = dir.path().join("large.txt");
    std::fs::File::create(&large)
        .unwrap()
        .set_len(2 * 1024 * 1024 + 1)
        .unwrap();
    let app = app();

    assert_eq!(
        get(&app, "/file-content", &[("path", path_str(&large))])
            .await
            .status,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert_eq!(
        get(&app, "/file-content", &[("path", "relative.txt")])
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
    let gone = get(
        &app,
        "/file-content",
        &[("path", path_str(&dir.path().join("gone.txt")))],
    )
    .await;
    assert_eq!(gone.status, StatusCode::NOT_FOUND);
    assert_eq!(gone.json(), json!({ "error": "File not found" }));
}

// ── project-files ───────────────────────────────────────────────────────

async fn listing(app: &Router, root: &Path, extra: &[(&str, &str)]) -> Value {
    let mut pairs = vec![("cwd", path_str(root))];
    pairs.extend_from_slice(extra);
    let reply = get(app, "/project-files", &pairs).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    reply.json()
}

#[tokio::test]
async fn project_files_use_git_so_ignored_files_stay_out() {
    let root = repository();
    write(&root.path().join(".gitignore"), "ignored.log\n");
    write(&root.path().join("visible.ts"), "export {}\n");
    write(&root.path().join("ignored.log"), "noise\n");

    let data = listing(&app(), root.path(), &[]).await;
    assert_eq!(data["files"], json!([".gitignore", "visible.ts"]));
}

#[tokio::test]
async fn project_files_walk_the_filesystem_outside_git() {
    let root = TempDir::new().unwrap();
    write(&root.path().join("src/app.ts"), "export {}\n");
    write(&root.path().join("node_modules/ignored.js"), "");
    write(&root.path().join("target/debug/out"), "");

    let data = listing(&app(), root.path(), &[]).await;
    assert_eq!(
        data,
        json!({ "files": ["src/app.ts"], "totalMatches": 1, "scanLimited": false })
    );
}

#[cfg(unix)]
#[tokio::test]
async fn project_files_walker_skips_symlinks() {
    let root = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    write(&outside.path().join("secret.ts"), "");
    write(&root.path().join("real.ts"), "");
    std::os::unix::fs::symlink(outside.path(), root.path().join("linked")).unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("secret.ts"),
        root.path().join("link.ts"),
    )
    .unwrap();

    let data = listing(&app(), root.path(), &[]).await;
    assert_eq!(data["files"], json!(["real.ts"]));
}

#[tokio::test]
async fn project_files_cache_the_listing_until_refresh_is_requested() {
    let root = TempDir::new().unwrap();
    write(&root.path().join("widget-0.ts"), "");
    let app = app();

    assert_eq!(
        listing(&app, root.path(), &[("limit", "100")]).await["files"],
        json!(["widget-0.ts"])
    );
    write(&root.path().join("widget-1.ts"), "");
    assert_eq!(
        listing(&app, root.path(), &[("limit", "100")]).await["files"],
        json!(["widget-0.ts"])
    );
    assert_eq!(
        listing(&app, root.path(), &[("limit", "100"), ("refresh", "1")]).await["files"],
        json!(["widget-0.ts", "widget-1.ts"])
    );
    assert_eq!(
        listing(&app, root.path(), &[("limit", "100")]).await["files"],
        json!(["widget-0.ts", "widget-1.ts"])
    );
}

#[tokio::test]
async fn project_files_report_the_full_match_count() {
    let root = TempDir::new().unwrap();
    for index in 0..5 {
        write(&root.path().join(format!("widget-{index}.ts")), "");
    }
    let app = app();

    let cut = listing(&app, root.path(), &[("q", "widget"), ("limit", "2")]).await;
    assert_eq!(cut["files"].as_array().map(Vec::len), Some(2));
    assert_eq!(cut["totalMatches"], 5);
    assert_eq!(cut["scanLimited"], false);

    let complete = listing(&app, root.path(), &[("q", "widget"), ("limit", "100")]).await;
    assert_eq!(complete["files"].as_array().map(Vec::len), Some(5));
    assert_eq!(complete["totalMatches"], 5);
}

#[tokio::test]
async fn project_files_tree_lists_one_directory_at_a_time() {
    let root = TempDir::new().unwrap();
    write(&root.path().join("src/lib/util.ts"), "");
    write(&root.path().join("src/main.ts"), "");
    write(&root.path().join("README.md"), "");
    let app = app();
    let cwd = path_str(root.path());

    let top = get(&app, "/project-files/tree", &[("cwd", cwd)]).await;
    assert_eq!(
        top.json(),
        json!({
            "entries": [{ "name": "src", "type": "directory" }, { "name": "README.md", "type": "file" }],
            "scanLimited": false,
        })
    );
    let nested = get(
        &app,
        "/project-files/tree",
        &[("cwd", cwd), ("dir", "/src/")],
    )
    .await;
    assert_eq!(
        nested.json()["entries"],
        json!([{ "name": "lib", "type": "directory" }, { "name": "main.ts", "type": "file" }])
    );

    let escape = get(
        &app,
        "/project-files/tree",
        &[("cwd", cwd), ("dir", "../outside")],
    )
    .await;
    assert_eq!(escape.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        escape.json(),
        json!({ "error": "dir must stay inside the project" })
    );
}

#[tokio::test]
async fn project_files_validate_the_cwd() {
    let root = TempDir::new().unwrap();
    let file = root.path().join("file.ts");
    write(&file, "");
    let app = app();

    let relative = get(&app, "/project-files", &[("cwd", "relative")]).await;
    assert_eq!(
        (relative.status, relative.json()),
        (
            StatusCode::BAD_REQUEST,
            json!({ "error": "cwd must be an absolute path" })
        )
    );
    let not_dir = get(&app, "/project-files", &[("cwd", path_str(&file))]).await;
    assert_eq!(
        (not_dir.status, not_dir.json()),
        (
            StatusCode::BAD_REQUEST,
            json!({ "error": "cwd must be a directory" })
        )
    );
    let missing = get(
        &app,
        "/project-files/tree",
        &[("cwd", path_str(&root.path().join("gone")))],
    )
    .await;
    assert_eq!(
        (missing.status, missing.json()),
        (
            StatusCode::NOT_FOUND,
            json!({ "error": "Project directory not found" })
        )
    );
}

// ── project-file ────────────────────────────────────────────────────────

fn project() -> TempDir {
    let root = TempDir::new().unwrap();
    write(&root.path().join("src/app.ts"), "export const value = 1\n");
    root
}

async fn read_file(app: &Router, root: &Path, path: &str) -> Reply {
    get(
        app,
        "/project-file",
        &[("cwd", path_str(root)), ("path", path)],
    )
    .await
}

fn save_body(root: &Path, path: &str, content: &str, mtime: &Value) -> String {
    json!({ "cwd": path_str(root), "path": path, "content": content, "expectedMtimeMs": mtime })
        .to_string()
}

#[tokio::test]
async fn project_file_reads_and_saves_with_optimistic_concurrency() {
    let root = project();
    let app = app();

    let read = read_file(&app, root.path(), "src/app.ts").await;
    assert_eq!(read.status, StatusCode::OK);
    assert_eq!(read.header("content-type"), Some("application/json"));
    let data = read.json();
    assert_eq!(data["content"], "export const value = 1\n");
    assert_eq!(data["size"], 23);
    assert_key_order(&read.text(), &["content", "mtimeMs", "size"]);

    let save = put_json(
        &app,
        "/project-file",
        &save_body(
            root.path(),
            "src/app.ts",
            "export const value = 2\n",
            &data["mtimeMs"],
        ),
    )
    .await;
    assert_eq!(save.status, StatusCode::OK, "{}", save.text());
    let saved = save.json();
    assert_eq!(saved["ok"], true);
    assert_eq!(saved["size"], 23);
    assert_eq!(
        std::fs::read_to_string(root.path().join("src/app.ts")).unwrap(),
        "export const value = 2\n"
    );

    let reread = read_file(&app, root.path(), "src/app.ts").await.json();
    assert_eq!(reread["mtimeMs"], saved["mtimeMs"]);
    let leftovers: Vec<_> = std::fs::read_dir(root.path().join("src"))
        .unwrap()
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .ends_with(".cogpit-save")
        })
        .collect();
    assert!(leftovers.is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn project_file_save_keeps_the_file_mode() {
    use std::os::unix::fs::PermissionsExt;
    let root = project();
    let script = root.path().join("run.sh");
    write(&script, "echo one\n");
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let app = app();

    let mtime = read_file(&app, root.path(), "run.sh").await.json()["mtimeMs"].clone();
    let save = put_json(
        &app,
        "/project-file",
        &save_body(root.path(), "run.sh", "echo two\n", &mtime),
    )
    .await;

    assert_eq!(save.status, StatusCode::OK);
    assert_eq!(
        std::fs::metadata(&script).unwrap().permissions().mode() & 0o777,
        0o755
    );
}

#[tokio::test]
async fn project_file_rejects_traversal() {
    let root = project();
    let app = app();

    let traversal = read_file(&app, root.path(), "../secret.txt").await;
    assert_eq!(traversal.status, StatusCode::FORBIDDEN);
    assert_eq!(
        traversal.json(),
        json!({ "error": "File is outside the project" })
    );

    let nested = read_file(&app, root.path(), "src/../../secret.txt").await;
    assert_eq!(nested.status, StatusCode::FORBIDDEN);

    let absolute = read_file(&app, root.path(), path_str(&root.path().join("src/app.ts"))).await;
    assert_eq!(absolute.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        absolute.json(),
        json!({ "error": "path must be a relative project file" })
    );
}

#[cfg(unix)]
#[tokio::test]
async fn project_file_rejects_symlinks_that_escape_the_project() {
    let root = project();
    let outside = TempDir::new().unwrap();
    write(&outside.path().join("secret.txt"), "secret");
    std::os::unix::fs::symlink(
        outside.path().join("secret.txt"),
        root.path().join("src/escape.txt"),
    )
    .unwrap();
    std::os::unix::fs::symlink(outside.path(), root.path().join("src/escape-dir")).unwrap();
    let app = app();

    let file = read_file(&app, root.path(), "src/escape.txt").await;
    assert_eq!(file.status, StatusCode::FORBIDDEN);
    let directory = read_file(&app, root.path(), "src/escape-dir/secret.txt").await;
    assert_eq!(directory.status, StatusCode::FORBIDDEN);
    let save = put_json(
        &app,
        "/project-file",
        &save_body(root.path(), "src/escape.txt", "pwned", &json!(0)),
    )
    .await;
    assert_eq!(save.status, StatusCode::FORBIDDEN);
    assert_eq!(
        std::fs::read_to_string(outside.path().join("secret.txt")).unwrap(),
        "secret"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn project_file_follows_symlinks_that_stay_inside() {
    let root = project();
    std::os::unix::fs::symlink(root.path().join("src/app.ts"), root.path().join("alias.ts"))
        .unwrap();

    let reply = read_file(&app(), root.path(), "alias.ts").await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.json()["content"], "export const value = 1\n");
}

#[tokio::test]
async fn project_file_returns_a_conflict_instead_of_overwriting() {
    let root = project();
    let path = root.path().join("src/app.ts");
    let app = app();

    let mtime = read_file(&app, root.path(), "src/app.ts").await.json()["mtimeMs"].clone();
    std::thread::sleep(std::time::Duration::from_millis(5));
    write(&path, "external change\n");

    let save = put_json(
        &app,
        "/project-file",
        &save_body(root.path(), "src/app.ts", "stale edit\n", &mtime),
    )
    .await;
    assert_eq!(save.status, StatusCode::CONFLICT);
    assert_eq!(
        save.json(),
        json!({ "error": "File changed on disk. Reload it before saving." })
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "external change\n");
}

#[tokio::test]
async fn project_file_refuses_binary_and_non_utf8_text_and_drops_a_bom() {
    let root = project();
    write(&root.path().join("logo.bin"), [0x89, 0x50, 0x00, 0x01]);
    write(&root.path().join("latin1.txt"), [0x63, 0x61, 0x66, 0xE9]);
    write(&root.path().join("bom.txt"), b"\xEF\xBB\xBFhello");
    let app = app();

    let binary = read_file(&app, root.path(), "logo.bin").await;
    assert_eq!(
        (binary.status, binary.json()),
        (
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            json!({ "error": "Binary files cannot be edited" })
        )
    );
    let latin = read_file(&app, root.path(), "latin1.txt").await;
    assert_eq!(
        (latin.status, latin.json()),
        (
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            json!({ "error": "File is not valid UTF-8 text" })
        )
    );
    assert_eq!(
        read_file(&app, root.path(), "bom.txt").await.json()["content"],
        "hello"
    );
    let folder = read_file(&app, root.path(), "src").await;
    assert_eq!(
        (folder.status, folder.json()),
        (
            StatusCode::BAD_REQUEST,
            json!({ "error": "Path must point to a file" })
        )
    );
    let missing = read_file(&app, root.path(), "src/gone.ts").await;
    assert_eq!(
        (missing.status, missing.json()),
        (StatusCode::NOT_FOUND, json!({ "error": "File not found" }))
    );
}

#[tokio::test]
async fn project_file_validates_save_bodies_like_the_typescript_route() {
    let root = project();
    let app = app();
    let required = json!({ "error": "cwd, path, content, and expectedMtimeMs are required" });
    let unexpected = json!({ "error": "Unable to access project file" });

    let missing = put_json(
        &app,
        "/project-file",
        &json!({ "cwd": path_str(root.path()), "path": "src/app.ts" }).to_string(),
    )
    .await;
    assert_eq!(
        (missing.status, missing.json()),
        (StatusCode::BAD_REQUEST, required.clone())
    );
    let string_mtime = put_json(
        &app,
        "/project-file",
        &save_body(root.path(), "src/app.ts", "x", &json!("1")),
    )
    .await;
    assert_eq!(
        (string_mtime.status, string_mtime.json()),
        (StatusCode::BAD_REQUEST, required.clone())
    );
    let array = put_json(&app, "/project-file", "[]").await;
    assert_eq!(
        (array.status, array.json()),
        (StatusCode::BAD_REQUEST, required)
    );
    let invalid = put_json(&app, "/project-file", "{not json").await;
    assert_eq!(
        (invalid.status, invalid.json()),
        (StatusCode::INTERNAL_SERVER_ERROR, unexpected.clone())
    );
    let null = put_json(&app, "/project-file", "null").await;
    assert_eq!(
        (null.status, null.json()),
        (StatusCode::INTERNAL_SERVER_ERROR, unexpected)
    );

    let large = "a".repeat(2 * 1024 * 1024 + 1);
    let too_large = put_json(
        &app,
        "/project-file",
        &save_body(root.path(), "src/app.ts", &large, &json!(0)),
    )
    .await;
    assert_eq!(
        (too_large.status, too_large.json()),
        (
            StatusCode::PAYLOAD_TOO_LARGE,
            json!({ "error": "File is larger than 2 MB" })
        )
    );
}

// ── git-status ──────────────────────────────────────────────────────────

#[tokio::test]
async fn git_status_reports_the_branch_and_working_tree_files() {
    let root = repository();
    write(&root.path().join("tracked.txt"), "one\n");
    commit_all(root.path(), "initial");
    write(&root.path().join("tracked.txt"), "two\n");

    let reply = get(&app(), "/git-status", &[("cwd", path_str(root.path()))]).await;

    assert_eq!(reply.status, StatusCode::OK);
    let data = reply.json();
    let canonical = dunce_root(root.path());
    assert_eq!(
        data,
        json!({
            "isRepository": true,
            "root": canonical,
            "branch": "main",
            "upstream": null,
            "ahead": 0,
            "behind": 0,
            "detached": false,
            "files": [{ "path": "tracked.txt", "indexStatus": " ", "workTreeStatus": "M" }],
        })
    );
    assert_key_order(
        &reply.text(),
        &[
            "isRepository",
            "root",
            "branch",
            "upstream",
            "ahead",
            "behind",
            "detached",
            "files",
        ],
    );
}

fn dunce_root(path: &Path) -> String {
    let canonical = std::fs::canonicalize(path).unwrap();
    let text = canonical.to_str().unwrap();
    text.strip_prefix(r"\\?\").unwrap_or(text).to_owned()
}

#[tokio::test]
async fn git_status_reports_paths_relative_to_a_subdirectory_cwd() {
    let root = repository();
    write(&root.path().join("top-level.txt"), "root\n");
    write(&root.path().join("packages/app/nested.txt"), "one\n");

    let reply = get(
        &app(),
        "/git-status",
        &[("cwd", path_str(&root.path().join("packages/app")))],
    )
    .await;

    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(
        reply.json()["files"],
        json!([{ "path": "nested.txt", "indexStatus": "?", "workTreeStatus": "?" }])
    );
}

#[tokio::test]
async fn git_status_reports_renames_with_their_original_path() {
    let root = repository();
    write(&root.path().join("old.txt"), "moved\n");
    commit_all(root.path(), "initial");
    git(root.path(), &["mv", "old.txt", "new.txt"]);

    let reply = get(&app(), "/git-status", &[("cwd", path_str(root.path()))]).await;

    assert_eq!(
        reply.json()["files"],
        json!([{ "path": "new.txt", "originalPath": "old.txt", "indexStatus": "R", "workTreeStatus": " " }])
    );
}

#[tokio::test]
async fn git_status_outside_a_repository_is_not_an_error() {
    let root = TempDir::new().unwrap();

    let reply = get(&app(), "/git-status", &[("cwd", path_str(root.path()))]).await;

    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.text(), r#"{"isRepository":false,"files":[]}"#);
}

#[tokio::test]
async fn git_status_validates_the_cwd() {
    let root = TempDir::new().unwrap();
    let app = app();

    let relative = get(&app, "/git-status", &[("cwd", "relative")]).await;
    assert_eq!(
        (relative.status, relative.json()),
        (
            StatusCode::BAD_REQUEST,
            json!({ "error": "cwd must be an absolute path" })
        )
    );
    let missing = get(
        &app,
        "/git-status",
        &[("cwd", path_str(&root.path().join("gone")))],
    )
    .await;
    assert_eq!(
        (missing.status, missing.json()),
        (
            StatusCode::NOT_FOUND,
            json!({ "error": "Project directory not found" })
        )
    );
}

// ── git-diff ────────────────────────────────────────────────────────────

async fn diff(root: &Path, path: &str, original: Option<&str>) -> Reply {
    let mut pairs = vec![("cwd", path_str(root)), ("path", path)];
    if let Some(original) = original {
        pairs.push(("originalPath", original));
    }
    get(&app(), "/git-diff", &pairs).await
}

#[tokio::test]
async fn git_diff_returns_committed_and_working_tree_content() {
    let root = repository();
    write(&root.path().join("tracked.txt"), "one\ntwo\n");
    commit_all(root.path(), "initial");
    write(&root.path().join("tracked.txt"), "one\nthree\n");

    let reply = diff(root.path(), "tracked.txt", None).await;

    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(
        reply.text(),
        r#"{"path":"tracked.txt","original":"one\ntwo\n","current":"one\nthree\n","binary":false,"tooLarge":false}"#
    );
}

#[tokio::test]
async fn git_diff_reports_added_deleted_and_renamed_files() {
    let root = repository();
    write(&root.path().join("gone.txt"), "bye\n");
    write(&root.path().join("old.txt"), "moved\n");
    commit_all(root.path(), "initial");
    write(&root.path().join("new.txt"), "fresh\n");
    std::fs::remove_file(root.path().join("gone.txt")).unwrap();
    git(root.path(), &["mv", "old.txt", "renamed.txt"]);

    let added = diff(root.path(), "new.txt", None).await.json();
    assert_eq!(
        (added["original"].clone(), added["current"].clone()),
        (Value::Null, json!("fresh\n"))
    );
    let deleted = diff(root.path(), "gone.txt", None).await.json();
    assert_eq!(
        (deleted["original"].clone(), deleted["current"].clone()),
        (json!("bye\n"), Value::Null)
    );
    let renamed = diff(root.path(), "renamed.txt", Some("old.txt"))
        .await
        .json();
    assert_eq!(
        (renamed["original"].clone(), renamed["current"].clone()),
        (json!("moved\n"), json!("moved\n"))
    );
}

#[tokio::test]
async fn git_diff_resolves_paths_relative_to_a_subdirectory_cwd() {
    let root = repository();
    let nested = root.path().join("packages/app");
    write(&nested.join("nested.txt"), "one\n");
    commit_all(root.path(), "initial");
    write(&nested.join("nested.txt"), "two\n");

    let data = diff(&nested, "nested.txt", None).await.json();

    assert_eq!(
        (data["original"].clone(), data["current"].clone()),
        (json!("one\n"), json!("two\n"))
    );
}

#[tokio::test]
async fn git_diff_flags_binary_files_instead_of_returning_their_bytes() {
    let root = repository();
    write(
        &root.path().join("logo.bin"),
        [0x89, 0x50, 0x00, 0x01, 0x02],
    );
    commit_all(root.path(), "initial");
    write(
        &root.path().join("logo.bin"),
        [0x89, 0x50, 0x00, 0x03, 0x04],
    );

    let data = diff(root.path(), "logo.bin", None).await.json();

    assert_eq!(
        data,
        json!({ "path": "logo.bin", "original": null, "current": null, "binary": true, "tooLarge": false })
    );
}

#[tokio::test]
async fn git_diff_rejects_paths_outside_the_project() {
    let root = repository();
    write(&root.path().join("tracked.txt"), "one\n");
    commit_all(root.path(), "initial");

    let escape = diff(root.path(), "../escape.txt", None).await;
    assert_eq!(
        (escape.status, escape.json()),
        (
            StatusCode::FORBIDDEN,
            json!({ "error": "File is outside the project" })
        )
    );
    let original_escape = diff(root.path(), "tracked.txt", Some("../escape.txt")).await;
    assert_eq!(original_escape.status, StatusCode::FORBIDDEN);
    let absolute = diff(
        root.path(),
        path_str(&root.path().join("tracked.txt")),
        None,
    )
    .await;
    assert_eq!(
        (absolute.status, absolute.json()),
        (
            StatusCode::BAD_REQUEST,
            json!({ "error": "path must be a relative project file" })
        )
    );
}

#[cfg(unix)]
#[tokio::test]
async fn git_diff_does_not_read_through_a_symlink_that_escapes() {
    let root = repository();
    let outside = TempDir::new().unwrap();
    write(&outside.path().join("secret.txt"), "secret\n");
    std::os::unix::fs::symlink(
        outside.path().join("secret.txt"),
        root.path().join("link.txt"),
    )
    .unwrap();

    let data = diff(root.path(), "link.txt", None).await.json();

    assert_eq!(data["current"], Value::Null);
}

#[tokio::test]
async fn git_diff_refuses_to_diff_outside_a_repository() {
    let root = TempDir::new().unwrap();
    write(&root.path().join("loose.txt"), "one\n");

    let reply = diff(root.path(), "loose.txt", None).await;

    assert_eq!(
        (reply.status, reply.json()),
        (
            StatusCode::BAD_REQUEST,
            json!({ "error": "Not a git repository" })
        )
    );
}

#[tokio::test]
async fn git_diff_treats_a_blob_past_the_output_ceiling_as_absent() {
    let root = repository();
    write(&root.path().join("huge.txt"), "a".repeat(9 * 1024 * 1024));
    commit_all(root.path(), "initial");

    let data = diff(root.path(), "huge.txt", None).await.json();

    assert_eq!(
        data,
        json!({ "path": "huge.txt", "original": null, "current": null, "binary": false, "tooLarge": true })
    );
}
