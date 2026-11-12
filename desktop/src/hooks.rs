//! Functions the renderer registers on `window` for the shell to call. Each is
//! registered once the part of the app that handles it has mounted, so its
//! presence doubles as the "ready" ack.

use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use tauri::WebviewWindow;

pub const REVEAL_SESSION: &str = "__cogpitRevealSession";
pub const OPEN_KEYBOARD_SHORTCUTS: &str = "__cogpitOpenKeyboardShortcuts";

/// How long a call keeps retrying to reach a renderer that is still booting.
const ATTEMPTS: usize = 20;
const RETRY_DELAY: Duration = Duration::from_millis(250);

/// Call a renderer hook, retrying while the renderer is still loading: a
/// fire-and-forget call would land in a renderer that is still booting (cold
/// start, mid-reload) and be silently dropped. Runs on a thread of its own.
pub fn call(window: &WebviewWindow, hook: &'static str, arg: Option<String>) {
    let window = window.clone();
    thread::spawn(move || {
        let script = script(hook, arg.as_deref());
        for _ in 0..ATTEMPTS {
            let (answered, answer) = mpsc::channel();
            let evaluated = window.eval_with_callback(&script, move |result| {
                let _ = answered.send(result == "true");
            });
            if evaluated.is_ok() && answer.recv_timeout(RETRY_DELAY * 4).unwrap_or(false) {
                return;
            }
            thread::sleep(RETRY_DELAY);
        }
        eprintln!("[shell] The renderer never answered {hook}");
    });
}

fn script(hook: &str, arg: Option<&str>) -> String {
    let arg = arg
        .map(|arg| serde_json::to_string(arg).expect("strings serialize"))
        .unwrap_or_default();
    format!(r#"typeof window.{hook} === "function" ? (window.{hook}({arg}), true) : false"#)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_the_argument_as_a_javascript_string() {
        assert_eq!(
            script(REVEAL_SESSION, Some("/a\"b/</script>")),
            r#"typeof window.__cogpitRevealSession === "function" ? (window.__cogpitRevealSession("/a\"b/</script>"), true) : false"#
        );
        assert_eq!(
            script(OPEN_KEYBOARD_SHORTCUTS, None),
            r#"typeof window.__cogpitOpenKeyboardShortcuts === "function" ? (window.__cogpitOpenKeyboardShortcuts(), true) : false"#
        );
    }
}
