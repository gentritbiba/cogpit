//! The one app window. It opens on the bundled loading page and moves to the
//! local server once the server is listening; every API is on that origin.

use tauri::webview::{NewWindowResponse, PermissionKind, PermissionResponse};
use tauri::window::Color;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use url::Url;

use tauri::webview::DownloadEvent;

use crate::{Shell, WindowState, navigation, presence_changed};

pub const MAIN: &str = "main";

/// The open window, or a new one.
pub fn show(app: &AppHandle) -> WebviewWindow {
    let window = app.get_webview_window(MAIN).unwrap_or_else(|| create(app));
    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }
    let _ = window.show();
    let _ = window.set_focus();
    window
}

pub fn create(app: &AppHandle) -> WebviewWindow {
    let origin = app.state::<Shell>().origin();
    let url = origin.clone().map_or_else(
        || WebviewUrl::App("index.html".into()),
        WebviewUrl::External,
    );
    let navigating = app.clone();
    let builder = WebviewWindowBuilder::new(app, MAIN, url)
        .title("Cogpit")
        .inner_size(1400.0, 900.0)
        .min_inner_size(800.0, 600.0)
        .background_color(Color(9, 9, 11, 255))
        // The renderer handles dropped files itself, which the native handler would swallow.
        .disable_drag_drop_handler()
        .on_navigation(move |url| {
            let decision = navigation::decide(url, navigating.state::<Shell>().origin().as_ref());
            if let Some(external) = decision.external {
                open_external(&external);
            }
            decision.allow
        })
        .on_new_window(|url, _features| {
            if let Some(external) = navigation::external_browser_url(&url) {
                open_external(&external);
            }
            NewWindowResponse::Deny
        })
        // The webview picks a free name in the Downloads folder; without a handler it drops downloads.
        .on_download(|_webview, event| {
            if let DownloadEvent::Finished {
                url,
                success: false,
                ..
            } = event
            {
                eprintln!("[shell] The download of {url} failed");
            }
            true
        })
        .on_permission_request(|webview, kind| {
            let on_app = webview
                .url()
                .ok()
                .zip(webview.app_handle().state::<Shell>().origin());
            match kind {
                // Dictation records from the composer; nothing else in Cogpit asks for a device.
                PermissionKind::Microphone
                    if on_app.is_some_and(|(url, origin)| url.origin() == origin.origin()) =>
                {
                    PermissionResponse::Allow
                }
                PermissionKind::Microphone | PermissionKind::Camera => PermissionResponse::Deny,
                _ => PermissionResponse::Default,
            }
        });
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(16.0, 14.0));
    let window = builder.build().expect("create the app window");

    let reporting = app.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Focused(_) => presence_changed(&reporting, WindowState::Unchanged),
        WindowEvent::Destroyed => presence_changed(&reporting, WindowState::Closed),
        _ => {}
    });
    presence_changed(app, WindowState::Unchanged);
    window
}

/// Move the window from the loading page to the app.
pub fn open_app(app: &AppHandle, origin: &Url) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.navigate(origin.clone());
    }
}

pub fn open_external(url: &Url) {
    if let Err(error) = open::that_detached(url.as_str()) {
        eprintln!("[shell] Could not open {url} in the browser: {error}");
    }
}
