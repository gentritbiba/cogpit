//! Which navigations the window may make. Cogpit is one page served by the
//! local server, so the window only ever shows that origin; a link to
//! anywhere else opens in the system browser instead.
//!
//! The webview reports navigations of every frame on macOS and Linux without
//! saying which frame, so this cannot tell an iframe from the window. The
//! server's CSP already keeps frames on the app origin, and it refuses a
//! frame that navigates to anything but a plugin or view shell.

use url::Url;

#[derive(Debug, PartialEq, Eq)]
pub struct Decision {
    pub allow: bool,
    /// Open this URL in the system browser.
    pub external: Option<Url>,
}

/// An http(s) URL safe to hand to the system browser, or None.
pub fn external_browser_url(url: &Url) -> Option<Url> {
    let web = matches!(url.scheme(), "http" | "https");
    (web && url.username().is_empty() && url.password().is_none()).then(|| url.clone())
}

/// `app_origin` is None while the loading page shows, before the server is ready.
pub fn decide(url: &Url, app_origin: Option<&Url>) -> Decision {
    let allow = is_shell_page(url)
        || matches!(url.as_str(), "about:blank" | "about:srcdoc")
        || matches!(url.scheme(), "blob" | "data")
        || app_origin.is_some_and(|origin| url.origin() == origin.origin());
    Decision {
        allow,
        external: if allow {
            None
        } else {
            external_browser_url(url)
        },
    }
}

/// The bundled loading page: `tauri://localhost` on macOS and Linux, `http(s)://tauri.localhost` on Windows.
fn is_shell_page(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }

    fn origin() -> Url {
        url("http://127.0.0.1:51234")
    }

    #[test]
    fn allows_the_app_origin() {
        let decision = decide(
            &url("http://127.0.0.1:51234/-Users-me-proj/abc"),
            Some(&origin()),
        );
        assert_eq!(
            decision,
            Decision {
                allow: true,
                external: None
            }
        );
    }

    #[test]
    fn opens_other_sites_in_the_browser() {
        let decision = decide(
            &url("https://github.com/gentritbiba/cogpit"),
            Some(&origin()),
        );
        assert!(!decision.allow);
        assert_eq!(
            decision.external,
            Some(url("https://github.com/gentritbiba/cogpit"))
        );
    }

    #[test]
    fn treats_another_local_port_as_another_site() {
        let decision = decide(&url("http://127.0.0.1:3000/"), Some(&origin()));
        assert!(!decision.allow);
        assert_eq!(decision.external, Some(url("http://127.0.0.1:3000/")));
    }

    #[test]
    fn never_hands_credentials_or_other_schemes_to_the_browser() {
        for target in [
            "https://user:pass@example.com/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "mailto:a@b.c",
        ] {
            let decision = decide(&url(target), Some(&origin()));
            assert_eq!(
                decision,
                Decision {
                    allow: false,
                    external: None
                },
                "{target}"
            );
        }
    }

    #[test]
    fn allows_the_loading_page_and_frame_documents() {
        for target in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/index.html",
            "about:blank",
            "about:srcdoc",
            "blob:http://127.0.0.1:51234/1f0c",
        ] {
            assert!(decide(&url(target), Some(&origin())).allow, "{target}");
        }
    }

    #[test]
    fn allows_nothing_but_the_loading_page_before_the_server_is_ready() {
        assert!(decide(&url("tauri://localhost/index.html"), None).allow);
        let decision = decide(&url("http://127.0.0.1:51234/"), None);
        assert!(!decision.allow);
    }
}
