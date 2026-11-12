//! Node's `path` semantics for the handful of operations these routes rely on.
//!
//! The routes take paths from query strings and compare them the way the
//! TypeScript server did with `node:path`, so both flavours are ported as plain
//! string functions: [`posix`] and [`win32`] compile and are tested on every
//! host, and [`native`] picks the one for the running platform.

/// Split on `is_sep`, dropping empty and `.` segments and resolving `..`
/// against the segments before it. `..` above the root is discarded.
fn normalize_segments(tail: &str, is_sep: fn(char) -> bool) -> Vec<&str> {
    let mut segments: Vec<&str> = Vec::new();
    for segment in tail.split(is_sep) {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            other => segments.push(other),
        }
    }
    segments
}

/// `isWithinDir` and a relative-path helper for one flavour, built on its
/// `resolve_from`, `comparable` and `SEP`.
macro_rules! containment {
    () => {
        fn resolve_one(path: &str) -> String {
            resolve_from(&super::current_dir(), &[path])
        }

        /// `isWithinDir` from `server/pathSafety.ts`: whether `child`,
        /// lexically resolved, is `parent` or one of its descendants.
        pub fn is_within_dir(parent: &str, child: &str) -> bool {
            let child = comparable(&resolve_one(child));
            let parent = comparable(&resolve_one(parent));
            child == parent || child.starts_with(&format!("{parent}{SEP}"))
        }

        /// `child` relative to `parent` with `/` separators, or `None` when it
        /// is not inside `parent`; `""` when they are the same path. Compared
        /// segment by segment, so a filesystem root (`/`, `D:\`) works as a
        /// parent the way `path.relative` treats it.
        pub fn relative_inside(parent: &str, child: &str) -> Option<String> {
            let parent = resolve_one(parent);
            let child = resolve_one(child);
            let parent: Vec<&str> = parent.split(SEP).filter(|s| !s.is_empty()).collect();
            let mut child = child.split(SEP).filter(|s| !s.is_empty());
            for expected in &parent {
                if comparable(child.next()?) != comparable(expected) {
                    return None;
                }
            }
            Some(child.collect::<Vec<_>>().join("/"))
        }
    };
}

fn current_dir() -> String {
    std::env::current_dir()
        .map(|dir| dir.to_string_lossy().into_owned())
        .unwrap_or_default()
}

pub mod posix {
    use super::normalize_segments;

    pub const SEP: char = '/';

    fn is_sep(c: char) -> bool {
        c == '/'
    }

    pub fn is_absolute(path: &str) -> bool {
        path.starts_with('/')
    }

    /// `path.posix.resolve(...paths)`, with `cwd` standing in for `process.cwd()`.
    pub fn resolve_from(cwd: &str, paths: &[&str]) -> String {
        let mut tail = String::new();
        let mut absolute = false;
        for path in paths.iter().rev().copied().chain(std::iter::once(cwd)) {
            if path.is_empty() {
                continue;
            }
            tail = format!("{path}/{tail}");
            if is_absolute(path) {
                absolute = true;
                break;
            }
        }
        let joined = normalize_segments(&tail, is_sep).join("/");
        if absolute {
            format!("/{joined}")
        } else {
            joined
        }
    }

    pub fn extname(path: &str) -> &str {
        super::extname_from(path, 0, is_sep)
    }

    fn comparable(path: &str) -> String {
        path.to_owned()
    }

    containment!();
}

pub mod win32 {
    use super::normalize_segments;

    pub const SEP: char = '\\';

    fn is_sep(c: char) -> bool {
        c == '/' || c == '\\'
    }

    fn has_drive(path: &str) -> bool {
        let bytes = path.as_bytes();
        bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
    }

    pub fn is_absolute(path: &str) -> bool {
        let mut chars = path.chars();
        match chars.next() {
            Some(c) if is_sep(c) => true,
            Some(_) => has_drive(path) && path.chars().nth(2).is_some_and(is_sep),
            None => false,
        }
    }

    /// Device (`C:` or `\\server\share`), where the tail starts, and whether
    /// the path is rooted, mirroring the root parsing in Node's `win32.resolve`.
    fn parse_root(path: &str) -> (String, usize, bool) {
        let bytes = path.as_bytes();
        let sep = |i: usize| bytes.get(i).is_some_and(|b| *b == b'/' || *b == b'\\');
        if bytes.len() == 1 {
            return (String::new(), usize::from(sep(0)), sep(0));
        }
        if sep(0) {
            if !sep(1) {
                return (String::new(), 1, true);
            }
            let len = bytes.len();
            let mut j = 2;
            while j < len && !sep(j) {
                j += 1;
            }
            if j < len && j != 2 {
                let server = &path[2..j];
                let mut last = j;
                while j < len && sep(j) {
                    j += 1;
                }
                if j < len && j != last {
                    last = j;
                    while j < len && !sep(j) {
                        j += 1;
                    }
                    if j == len || j != last {
                        return (format!("\\\\{server}\\{}", &path[last..j]), j, true);
                    }
                }
            }
            return (String::new(), 0, true);
        }
        if has_drive(path) {
            let rooted = sep(2);
            return (path[..2].to_owned(), if rooted { 3 } else { 2 }, rooted);
        }
        (String::new(), 0, false)
    }

    /// `path.win32.resolve(...paths)`, with `cwd` standing in for `process.cwd()`.
    pub fn resolve_from(cwd: &str, paths: &[&str]) -> String {
        let mut device = String::new();
        let mut tail = String::new();
        let mut absolute = false;
        let mut candidates: Vec<String> = paths.iter().rev().map(|p| (*p).to_owned()).collect();
        candidates.push(String::new());
        for (index, candidate) in candidates.into_iter().enumerate() {
            let path = if index < paths.len() {
                if candidate.is_empty() {
                    continue;
                }
                candidate
            } else if !device.is_empty()
                && !cwd
                    .get(..2)
                    .is_some_and(|d| d.eq_ignore_ascii_case(&device))
                && cwd.as_bytes().get(2) == Some(&b'\\')
            {
                format!("{device}\\")
            } else {
                cwd.to_owned()
            };
            let (path_device, root_end, rooted) = parse_root(&path);
            if !path_device.is_empty() {
                if device.is_empty() {
                    device = path_device;
                } else if !path_device.eq_ignore_ascii_case(&device) {
                    continue;
                }
            }
            if absolute {
                if !device.is_empty() {
                    break;
                }
            } else {
                tail = format!("{}\\{tail}", &path[root_end..]);
                absolute = rooted;
                if rooted && !device.is_empty() {
                    break;
                }
            }
        }
        let joined = normalize_segments(&tail, is_sep).join("\\");
        if absolute {
            format!("{device}\\{joined}")
        } else if device.is_empty() && joined.is_empty() {
            ".".to_owned()
        } else {
            format!("{device}{joined}")
        }
    }

    pub fn extname(path: &str) -> &str {
        super::extname_from(path, if has_drive(path) { 2 } else { 0 }, is_sep)
    }

    /// Windows filesystems ignore case, so containment checks fold it.
    fn comparable(path: &str) -> String {
        path.to_lowercase()
    }

    containment!();
}

/// Node's `extname` scan, starting after `start` (past a drive on win32).
fn extname_from(path: &str, start: usize, is_sep: fn(char) -> bool) -> &str {
    let bytes = path.as_bytes();
    let mut start_dot: Option<usize> = None;
    let mut start_part = start;
    let mut end: Option<usize> = None;
    let mut matched_slash = true;
    let mut pre_dot_state = 0i8;
    for i in (start..bytes.len()).rev() {
        let c = bytes[i] as char;
        if bytes[i].is_ascii() && is_sep(c) {
            if !matched_slash {
                start_part = i + 1;
                break;
            }
            continue;
        }
        if end.is_none() {
            matched_slash = false;
            end = Some(i + 1);
        }
        if c == '.' {
            if start_dot.is_none() {
                start_dot = Some(i);
            } else if pre_dot_state != 1 {
                pre_dot_state = 1;
            }
        } else if start_dot.is_some() {
            pre_dot_state = -1;
        }
    }
    match (start_dot, end) {
        (Some(dot), Some(end))
            if pre_dot_state != 0
                && !(pre_dot_state == 1 && dot == end - 1 && dot == start_part + 1) =>
        {
            &path[dot..end]
        }
        _ => "",
    }
}

/// The running platform's path flavour, the way `node:path` picks one.
pub mod native {
    #[cfg(not(windows))]
    pub use super::posix::{extname, is_absolute, is_within_dir, relative_inside, resolve_from};
    #[cfg(windows)]
    pub use super::win32::{extname, is_absolute, is_within_dir, relative_inside, resolve_from};

    /// `path.resolve(...paths)` against the process working directory.
    pub fn resolve(paths: &[&str]) -> String {
        resolve_from(&super::current_dir(), paths)
    }
}

#[cfg(test)]
mod tests {
    use super::{posix, win32};

    /// Expected values were produced by Node's (and Bun's) `node:path`.
    #[test]
    fn win32_resolve_matches_node() {
        let cases: &[(&[&str], &str)] = &[
            (&["C:\\Users\\Alice"], "C:\\Users\\Alice"),
            (&["c:/users/alice/../bob"], "c:\\users\\bob"),
            (&["C:\\a", "b\\..\\c"], "C:\\a\\c"),
            (&["C:\\a", "D:\\x"], "D:\\x"),
            (&["C:\\a", "\\rooted"], "C:\\rooted"),
            (
                &["\\\\server\\share\\dir\\..\\..\\x"],
                "\\\\server\\share\\x",
            ),
            (&["//server/share/a/./b"], "\\\\server\\share\\a\\b"),
            (&["C:\\a\\", "..\\..\\..\\.."], "C:\\"),
            (&["C:\\"], "C:\\"),
            (&["C:\\a", "C:rel"], "C:\\a\\rel"),
            (&["\\\\server\\share"], "\\\\server\\share\\"),
            (&["C:\\a", "b/c/"], "C:\\a\\b\\c"),
        ];
        for (paths, expected) in cases {
            assert_eq!(
                win32::resolve_from("C:\\cwd", paths),
                *expected,
                "{paths:?}"
            );
        }
        assert_eq!(win32::resolve_from("D:\\work", &["\\rooted"]), "D:\\rooted");
    }

    #[test]
    fn posix_resolve_matches_node() {
        let cases: &[(&[&str], &str)] = &[
            (&["/a/b/../c"], "/a/c"),
            (&["/a", "b", "../../.."], "/"),
            (&["/a", "/b"], "/b"),
            (&["/a//b/./c/"], "/a/b/c"),
            (&["/"], "/"),
            (&["/a", ""], "/a"),
            (&["rel"], "/cwd/rel"),
        ];
        for (paths, expected) in cases {
            assert_eq!(posix::resolve_from("/cwd", paths), *expected, "{paths:?}");
        }
    }

    #[test]
    fn extname_matches_node() {
        let shared = [
            ("/a/b.PNG", ".PNG"),
            ("/a/.png", ""),
            ("/a/b.", "."),
            ("/a/b.png/", ".png"),
            ("/a/b..png", ".png"),
            ("/a/..png", ".png"),
            ("/a.b/c", ""),
            ("/a/b.tar.gz", ".gz"),
            ("/a/..", ""),
            ("/a/.", ""),
            ("x", ""),
            ("/a/vidéo.mp4", ".mp4"),
        ];
        for (path, expected) in shared {
            assert_eq!(posix::extname(path), expected, "{path}");
            assert_eq!(win32::extname(path), expected, "{path}");
        }
        for (path, expected) in [
            ("C:\\a\\b.mp4", ".mp4"),
            ("C:.png", ""),
            ("C:\\.png", ""),
            ("C:\\x\\y.webm\\", ".webm"),
            ("\\\\s\\h\\v.mov", ".mov"),
        ] {
            assert_eq!(win32::extname(path), expected, "{path}");
        }
        assert_eq!(posix::extname("/a\\b.png\\"), ".png\\");
    }

    #[test]
    fn absolute_paths_follow_each_platform() {
        assert!(posix::is_absolute("/a"));
        assert!(!posix::is_absolute("a"));
        assert!(!posix::is_absolute("C:\\a"));
        assert!(!posix::is_absolute(""));
        for (path, expected) in [
            ("C:\\a", true),
            ("C:/a", true),
            ("C:a", false),
            ("\\a", true),
            ("/a", true),
            ("a", false),
            ("", false),
            ("\\\\s\\h", true),
            ("1:\\a", false),
        ] {
            assert_eq!(win32::is_absolute(path), expected, "{path}");
        }
    }

    #[test]
    fn posix_containment() {
        assert!(posix::is_within_dir("/home/user", "/home/user/file.txt"));
        assert!(posix::is_within_dir("/home/user", "/home/user/a/b/c"));
        assert!(posix::is_within_dir("/home/user", "/home/user"));
        assert!(posix::is_within_dir("/home/user/", "/home/user/x/"));
        assert!(!posix::is_within_dir("/home/user", "/home/other/file.txt"));
        assert!(!posix::is_within_dir(
            "/home/user",
            "/home/user/../other/file.txt"
        ));
        assert!(!posix::is_within_dir("/home/user", "/home/username"));
        assert!(!posix::is_within_dir("/home/user/docs", "/home/user"));
        // Case folding would let `/HOME/user` escape a `/home/user` check.
        assert!(!posix::is_within_dir("/home/user", "/HOME/USER/file.txt"));
        assert!(!posix::is_within_dir("/home/user", "/Home/User"));
        // A backslash is an ordinary character on POSIX, not a separator.
        assert!(!posix::is_within_dir("/home/user", "/home/user\\..\\other"));
        assert!(posix::is_within_dir(
            "/home/user",
            "/home/user/a\\..\\..\\b"
        ));
    }

    #[test]
    fn win32_containment() {
        assert!(win32::is_within_dir(
            "C:\\Users\\Alice",
            "c:\\users\\alice\\file.txt"
        ));
        assert!(win32::is_within_dir("C:\\users\\alice", "C:\\Users\\Alice"));
        assert!(win32::is_within_dir(
            "C:\\Users\\Alice",
            "C:/Users/Alice/sub/file.txt"
        ));
        assert!(win32::is_within_dir(
            "/Users/Alice",
            "/users/alice/file.txt"
        ));
        assert!(!win32::is_within_dir(
            "C:\\Users\\Alice",
            "c:\\users\\alicexyz"
        ));
        assert!(!win32::is_within_dir(
            "C:\\Users\\Alice",
            "C:\\Users\\Alice\\..\\Bob"
        ));
        assert!(!win32::is_within_dir(
            "C:\\Users\\Alice",
            "C:\\Users\\Alice/../Bob"
        ));
        assert!(!win32::is_within_dir(
            "C:\\Users\\Alice",
            "D:\\Users\\Alice\\file.txt"
        ));
        assert!(win32::is_within_dir(
            "\\\\server\\share\\dir",
            "\\\\SERVER\\Share\\dir\\file"
        ));
        assert!(win32::is_within_dir(
            "\\\\server\\share\\dir",
            "//server/share/dir/file"
        ));
        assert!(!win32::is_within_dir(
            "\\\\server\\share\\dir",
            "\\\\server\\other\\dir\\file"
        ));
        assert!(!win32::is_within_dir(
            "\\\\server\\share\\dir",
            "\\\\server\\share\\dir\\..\\..\\x"
        ));
        assert!(!win32::is_within_dir(
            "C:\\Users\\Alice",
            "\\\\server\\share\\Users\\Alice"
        ));
    }

    #[test]
    fn relative_paths_inside_a_parent() {
        assert_eq!(
            posix::relative_inside("/repo", "/repo/packages/app").as_deref(),
            Some("packages/app")
        );
        assert_eq!(
            posix::relative_inside("/repo", "/repo").as_deref(),
            Some("")
        );
        assert_eq!(posix::relative_inside("/repo", "/repo/../x"), None);
        assert_eq!(posix::relative_inside("/repo", "/repository"), None);
        assert_eq!(
            win32::relative_inside("C:\\Repo", "c:\\repo\\Packages\\App").as_deref(),
            Some("Packages/App")
        );
        assert_eq!(
            win32::relative_inside("\\\\s\\h\\repo", "\\\\s\\h\\repo\\a\\b").as_deref(),
            Some("a/b")
        );
        assert_eq!(win32::relative_inside("C:\\Repo", "D:\\Repo\\x"), None);
        assert_eq!(
            posix::relative_inside("/", "/repo/app").as_deref(),
            Some("repo/app")
        );
        assert_eq!(
            win32::relative_inside("D:\\", "d:\\Project").as_deref(),
            Some("Project")
        );
        assert_eq!(win32::relative_inside("D:\\", "C:\\Project"), None);
    }
}
