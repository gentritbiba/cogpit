use std::collections::HashMap;
use std::fs;

/// `shared/helpLinks.ts` is the one list of help URLs; the Help menu reads them
/// from here as compile-time constants.
const HELP_LINKS: &str = "../shared/helpLinks.ts";
const HELP_MENU_LINKS: [&str; 2] = ["DOCUMENTATION_URL", "REPORT_ISSUE_URL"];

/// The loading page the window shows while the server starts carries the app mark.
const APP_MARK: &str = "../public/cogpit.svg";

fn main() {
    println!("cargo:rerun-if-changed={HELP_LINKS}");
    let links =
        string_constants(&fs::read_to_string(HELP_LINKS).expect("read shared/helpLinks.ts"));
    for name in HELP_MENU_LINKS {
        let value = links
            .get(name)
            .unwrap_or_else(|| panic!("{HELP_LINKS} no longer defines {name} as a string"));
        println!("cargo:rustc-env=COGPIT_{name}={value}");
    }

    println!("cargo:rerun-if-changed={APP_MARK}");
    fs::copy(APP_MARK, "loading/cogpit.svg").expect("copy the app mark into the loading page");

    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "performance_snapshot",
            "update_state",
            "update_install",
            "update_dismiss",
        ]),
    ))
    .expect("tauri build");
}

/// `const NAME = "…"` and `` const NAME = `…${OTHER}…` `` declarations, in order.
fn string_constants(source: &str) -> HashMap<String, String> {
    let mut constants: HashMap<String, String> = HashMap::new();
    for line in source.lines() {
        let Some(declaration) = line.trim_start_matches("export ").strip_prefix("const ") else {
            continue;
        };
        let Some((name, value)) = declaration.split_once(" = ") else {
            continue;
        };
        let value = value.trim();
        let Some(body) = value
            .strip_prefix('"')
            .and_then(|rest| rest.strip_suffix('"'))
            .or_else(|| {
                value
                    .strip_prefix('`')
                    .and_then(|rest| rest.strip_suffix('`'))
            })
        else {
            continue;
        };
        let mut resolved = body.to_owned();
        for (other, text) in &constants {
            resolved = resolved.replace(&format!("${{{other}}}"), text);
        }
        constants.insert(name.trim().to_owned(), resolved);
    }
    constants
}
