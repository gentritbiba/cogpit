//! The workspace forbids unsafe code; this crate only denies it so that the
//! Windows ConPTY backend can opt back in. Nothing else may.

use std::path::Path;

fn sources(dir: &Path, found: &mut Vec<std::path::PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            sources(&path, found);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            found.push(path);
        }
    }
}

#[test]
fn only_the_windows_backend_allows_unsafe_code() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    sources(&src, &mut files);
    let allowed = src.join("backend").join("windows.rs");
    let offenders: Vec<_> = files
        .iter()
        .filter(|file| **file != allowed)
        .filter(|file| {
            let text = std::fs::read_to_string(file).unwrap();
            [
                "unsafe_code",
                "unsafe {",
                "unsafe fn",
                "unsafe impl",
                "unsafe extern",
                "unsafe trait",
            ]
            .iter()
            .any(|needle| text.contains(needle))
        })
        .collect();
    assert!(
        offenders.is_empty(),
        "unsafe code outside backend/windows.rs: {offenders:?}"
    );
    assert!(
        std::fs::read_to_string(&allowed)
            .unwrap()
            .contains("#![allow(unsafe_code)]")
    );
}
