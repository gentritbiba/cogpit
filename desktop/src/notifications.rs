//! Desktop notifications the server asks for. The shell presents them because
//! it owns the native API, which attributes them to Cogpit, and reports a
//! click back so notification history reflects it.

use percent_encoding::percent_decode_str;
use tauri::{AppHandle, Manager, UserAttentionType};
use url::Url;

use crate::protocol::{NotificationNav, Notify, ShellMessage};
use crate::{hooks, window};

pub use platform::init;

/// Present a notification, unless the window is in front and already showing
/// that session: a backgrounded, minimized or elsewhere-scrolled window is
/// worth interrupting.
pub fn present(app: &AppHandle, notify: Notify) {
    if let Some(window) = app.get_webview_window(window::MAIN) {
        let in_front = window.is_focused().unwrap_or(false)
            && window.is_visible().unwrap_or(false)
            && !window.is_minimized().unwrap_or(false);
        let viewing = window
            .url()
            .is_ok_and(|url| is_viewing_session(&url, &notify.nav));
        if in_front && viewing {
            return;
        }
    }

    let clicked_app = app.clone();
    let Notify {
        title,
        body,
        history_id,
        path,
        ..
    } = notify;
    platform::show(
        app,
        &title,
        &body,
        Box::new(move || clicked(&clicked_app, history_id.clone(), path.clone())),
    );
    #[cfg(target_os = "macos")]
    if let Some(window) = app.get_webview_window(window::MAIN) {
        let _ = window.request_user_attention(Some(UserAttentionType::Informational));
    }
}

/// Reflect the click into notification history before anything can fail,
/// then bring Cogpit forward on the session that notified.
fn clicked(app: &AppHandle, history_id: Option<String>, path: Option<String>) {
    if let Some(history_id) = history_id {
        crate::send_to_server(app, &ShellMessage::NotificationClicked { history_id });
    }
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        let window = window::show(&app);
        if cfg!(windows) && !window.is_focused().unwrap_or(false) {
            // Windows can deny a foreground steal; flashing the taskbar button is the sanctioned way to ask instead.
            let _ = window.request_user_attention(Some(UserAttentionType::Critical));
        }
        if let Some(path) = path {
            hooks::call(&window, hooks::REVEAL_SESSION, Some(path));
        }
    });
}

/// True when the window already shows this session, so a notification for it
/// would be redundant. Codex notifications address a session by bare thread
/// id while the session list navigates to the dated rollout path ending in
/// that same id, so the session segment matches on suffix as well.
pub fn is_viewing_session(current: &Url, nav: &NotificationNav) -> bool {
    let (Some(dir_name), Some(session_id)) = (&nav.dir_name, &nav.session_id) else {
        return false;
    };
    let mut segments: Vec<String> = current
        .path_segments()
        .map(|segments| {
            segments
                .filter(|segment| !segment.is_empty())
                .map(decode_segment)
                .collect()
        })
        .unwrap_or_default();
    // Remote devices are addressed under a /d/{deviceId} prefix.
    if segments.first().is_some_and(|segment| segment == "d") {
        segments.drain(..segments.len().min(2));
    }
    match segments.as_slice() {
        [dir, session, ..] => {
            dir == dir_name && (session == session_id || session.ends_with(session_id.as_str()))
        }
        _ => false,
    }
}

fn decode_segment(segment: &str) -> String {
    percent_decode_str(segment)
        .decode_utf8()
        .map_or_else(|_| segment.to_owned(), |decoded| decoded.into_owned())
}

type OnClick = Box<dyn Fn() + Send + Sync>;

#[cfg(target_os = "macos")]
mod platform {
    use std::collections::{HashMap, VecDeque};
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicU64, Ordering};

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{AllocAnyThread, define_class, msg_send};
    use objc2_foundation::{NSBundle, NSError, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
        UNNotificationDismissActionIdentifier, UNNotificationPresentationOptions,
        UNNotificationRequest, UNNotificationResponse, UNNotificationSound,
        UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use tauri::AppHandle;

    use super::OnClick;

    /// Clicks waiting on notifications still on screen, oldest first.
    static PENDING: Mutex<Option<Pending>> = Mutex::new(None);
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    /// Notification Center keeps its own history; older entries stop being clickable here.
    const MAX_PENDING: usize = 200;

    #[derive(Default)]
    struct Pending {
        order: VecDeque<String>,
        clicks: HashMap<String, OnClick>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "CogpitNotificationDelegate"]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            /// Show it even while Cogpit is the active app; `present` already dropped the redundant ones.
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                handler.call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound,));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                handler: &block2::DynBlock<dyn Fn()>,
            ) {
                // SAFETY: an immutable framework constant.
                let dismissed = response
                    .actionIdentifier()
                    .isEqualToString(unsafe { UNNotificationDismissActionIdentifier });
                let id = response.notification().request().identifier().to_string();
                let click = PENDING.lock().unwrap().as_mut().and_then(|pending| {
                    pending.order.retain(|entry| entry != &id);
                    pending.clicks.remove(&id)
                });
                if let (false, Some(click)) = (dismissed, click) {
                    click();
                }
                handler.call(());
            }
        }
    );

    /// The notification center only exists for a process inside an app bundle;
    /// `tauri dev` runs a bare binary, which shows no notifications.
    fn bundled() -> bool {
        NSBundle::mainBundle()
            .bundlePath()
            .to_string()
            .ends_with(".app")
    }

    pub fn init(_app: &AppHandle) {
        if !bundled() {
            return;
        }
        let center = UNUserNotificationCenter::currentNotificationCenter();
        // SAFETY: NSObject's init on a freshly allocated instance of a subclass without ivars.
        let delegate: Retained<Delegate> = unsafe { msg_send![Delegate::alloc(), init] };
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        // The center holds its delegate weakly; this one lives as long as the app.
        std::mem::forget(delegate);
        let options = UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound;
        center.requestAuthorizationWithOptions_completionHandler(
            options,
            &RcBlock::new(|granted: Bool, _error: *mut NSError| {
                if !granted.as_bool() {
                    eprintln!("[notifications] macOS notifications are turned off for Cogpit");
                }
            }),
        );
    }

    pub fn show(_app: &AppHandle, title: &str, body: &str, on_click: OnClick) {
        if !bundled() {
            return;
        }
        let id = format!("cogpit-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed));
        {
            let mut guard = PENDING.lock().unwrap();
            let pending = guard.get_or_insert_default();
            pending.order.push_back(id.clone());
            pending.clicks.insert(id.clone(), on_click);
            while pending.order.len() > MAX_PENDING {
                if let Some(oldest) = pending.order.pop_front() {
                    pending.clicks.remove(&oldest);
                }
            }
        }
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        content.setBody(&NSString::from_str(body));
        content.setSound(Some(&UNNotificationSound::defaultSound()));
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(&id),
            &content,
            None,
        );
        let failed = RcBlock::new(|error: *mut NSError| {
            // SAFETY: the framework passes either null or a valid NSError for the duration of the call.
            if let Some(error) = unsafe { error.as_ref() } {
                eprintln!(
                    "[notifications] macOS refused a notification: {}",
                    error.localizedDescription()
                );
            }
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .addNotificationRequest_withCompletionHandler(&request, Some(&failed));
    }
}

#[cfg(windows)]
mod platform {
    use tauri::AppHandle;
    use tauri_winrt_notification::Toast;

    use super::OnClick;

    pub fn init(_app: &AppHandle) {}

    /// Windows routes toasts through the app's user model ID, which the
    /// installer registers as the bundle identifier. An unpackaged dev build has
    /// none, so it borrows PowerShell's.
    pub fn show(app: &AppHandle, title: &str, body: &str, on_click: OnClick) {
        let app_id = if cfg!(debug_assertions) {
            Toast::POWERSHELL_APP_ID.to_owned()
        } else {
            app.config().identifier.clone()
        };
        let shown = Toast::new(&app_id)
            .title(title)
            .text1(body)
            .on_activated(move |_| {
                on_click();
                Ok(())
            })
            .show();
        if let Err(error) = shown {
            eprintln!("[notifications] Windows refused a notification: {error}");
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use notify_rust::Notification;
    use tauri::AppHandle;

    use super::OnClick;

    pub fn init(_app: &AppHandle) {}

    /// A click is the notification's default action, which arrives while a
    /// thread waits on it; the wait ends when the notification closes.
    pub fn show(_app: &AppHandle, title: &str, body: &str, on_click: OnClick) {
        let shown = Notification::new()
            .appname("Cogpit")
            .summary(title)
            .body(body)
            .action("default", "Open")
            .show();
        match shown {
            Ok(handle) => {
                std::thread::spawn(move || {
                    handle.wait_for_action(|action| {
                        if action == "default" {
                            on_click();
                        }
                    })
                });
            }
            Err(error) => eprintln!("[notifications] Could not show a notification: {error}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nav(dir_name: &str, session_id: &str) -> NotificationNav {
        NotificationNav {
            dir_name: Some(dir_name.into()),
            session_id: Some(session_id.into()),
        }
    }

    fn viewing(url: &str, nav: &NotificationNav) -> bool {
        is_viewing_session(&Url::parse(url).unwrap(), nav)
    }

    const CLAUDE: (&str, &str) = ("-Users-me-proj", "abc-123");

    #[test]
    fn matches_the_session_currently_open() {
        assert!(viewing(
            "http://127.0.0.1:19384/-Users-me-proj/abc-123",
            &nav(CLAUDE.0, CLAUDE.1)
        ));
    }

    #[test]
    fn does_not_match_another_session_or_project() {
        let claude = nav(CLAUDE.0, CLAUDE.1);
        assert!(!viewing(
            "http://127.0.0.1:19384/-Users-me-proj/other-999",
            &claude
        ));
        assert!(!viewing(
            "http://127.0.0.1:19384/-Users-other-proj/abc-123",
            &claude
        ));
    }

    #[test]
    fn does_not_match_the_project_list_or_home() {
        let claude = nav(CLAUDE.0, CLAUDE.1);
        assert!(!viewing("http://127.0.0.1:19384/-Users-me-proj", &claude));
        assert!(!viewing("http://127.0.0.1:19384/", &claude));
    }

    #[test]
    fn matches_under_a_remote_device_prefix() {
        assert!(viewing(
            "http://127.0.0.1:19384/d/dev1/-Users-me-proj/abc-123",
            &nav(CLAUDE.0, CLAUDE.1)
        ));
    }

    #[test]
    fn matches_a_codex_rollout_path_ending_in_the_thread_id() {
        let thread = "019f9931-8d56-7431-85e0-ea2454609294";
        let url = format!(
            "http://127.0.0.1:19384/codex__L1VzZXJzL21l/2026%2F07%2F25%2Frollout-2026-07-25T10-00-00-{thread}"
        );
        assert!(viewing(&url, &nav("codex__L1VzZXJzL21l", thread)));
        assert!(viewing(
            "http://127.0.0.1:19384/codex__abc/2026%2F07%2F25%2Frollout-x",
            &nav("codex__abc", "2026/07/25/rollout-x")
        ));
    }

    #[test]
    fn keeps_a_plus_sign_literal() {
        assert!(viewing(
            "http://127.0.0.1:19384/-Users-me-c++/abc-123",
            &nav("-Users-me-c++", "abc-123")
        ));
    }

    #[test]
    fn needs_both_halves_of_the_link() {
        let url = "http://127.0.0.1:19384/-Users-me-proj/abc-123";
        assert!(!viewing(
            url,
            &NotificationNav {
                dir_name: None,
                session_id: None
            }
        ));
        assert!(!viewing(
            url,
            &NotificationNav {
                dir_name: Some(CLAUDE.0.into()),
                session_id: None
            }
        ));
    }
}
