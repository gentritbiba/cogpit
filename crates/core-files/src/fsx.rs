//! Filesystem helpers with Node's results: `realpath` without the `\\?\`
//! prefix on Windows, and `Stats.mtimeMs`.

use std::cmp::Ordering;
use std::fs::Metadata;
use std::io;
use std::sync::LazyLock;

use icu_collator::options::CollatorOptions;
use icu_collator::{Collator, CollatorBorrowed};

/// `fs.promises.realpath`, as a UTF-8 string.
pub async fn realpath(path: &str) -> io::Result<String> {
    let path = path.to_owned();
    let resolved = tokio::task::spawn_blocking(move || dunce::canonicalize(path))
        .await
        .map_err(io::Error::other)??;
    resolved
        .into_os_string()
        .into_string()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "path is not UTF-8"))
}

/// `Stats.mtimeMs`: seconds and nanoseconds combined the way libuv and Node do.
pub fn mtime_ms(info: &Metadata) -> f64 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        #[allow(clippy::cast_precision_loss)]
        let ms = info.mtime() as f64 * 1000.0 + info.mtime_nsec() as f64 / 1_000_000.0;
        ms
    }
    #[cfg(not(unix))]
    {
        use std::time::UNIX_EPOCH;
        match info.modified() {
            Ok(time) => match time.duration_since(UNIX_EPOCH) {
                Ok(after) => {
                    after.as_secs() as f64 * 1000.0 + f64::from(after.subsec_nanos()) / 1_000_000.0
                }
                Err(before) => {
                    let before = before.duration();
                    -(before.as_secs() as f64 * 1000.0
                        + f64::from(before.subsec_nanos()) / 1_000_000.0)
                }
            },
            Err(_) => 0.0,
        }
    }
}

/// UTF-8 decoding with replacement characters, like `Buffer#toString("utf-8")`.
pub fn lossy(bytes: Vec<u8>) -> String {
    match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(error) => String::from_utf8_lossy(error.as_bytes()).into_owned(),
    }
}

static COLLATOR: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| {
    Collator::try_new(Default::default(), CollatorOptions::default())
        .expect("the root collation is compiled in")
});

/// `a.localeCompare(b)` with the default locale's collation.
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    COLLATOR.compare(a, b)
}

#[cfg(test)]
mod tests {
    use super::locale_compare;

    /// The expected order is what `localeCompare` gives in both Node and Bun.
    #[test]
    fn collation_matches_javascript_locale_compare() {
        let mut names: Vec<&str> = serde_json::from_str(r##"["README.md","readme.md","src","Src","_private.ts",".gitignore",".env","-dash","~tilde","Zeta.ts","alpha.ts","a-b.ts","a_b.ts","a.b.ts","ab.ts","a b.ts","file10.ts","file2.ts","file1.ts","Ärger.md","arger.md","zebra.md","éclair.md","eclair.md","日本.md","123.md","9.md","@scope","#hash","$dollar","(paren)","[bracket]","{brace}","a/b.ts","a/c.ts","a.ts","ä.ts","A.ts","ß.ts","ss.ts","Œuvre.md","oeuvre.md"]"##).unwrap();
        let expected: Vec<&str> = serde_json::from_str(r##"["_private.ts","-dash",".env",".gitignore","(paren)","[bracket]","{brace}","@scope","#hash","~tilde","$dollar","123.md","9.md","a b.ts","a_b.ts","a-b.ts","a.b.ts","a.ts","A.ts","ä.ts","a/b.ts","a/c.ts","ab.ts","alpha.ts","arger.md","Ärger.md","eclair.md","éclair.md","file1.ts","file10.ts","file2.ts","oeuvre.md","Œuvre.md","readme.md","README.md","src","Src","ss.ts","ß.ts","zebra.md","Zeta.ts","日本.md"]"##).unwrap();
        names.sort_by(|a, b| locale_compare(a, b));
        assert_eq!(names, expected);
    }
}
