//! The application menu: the platform's app/Edit/Window menus, View actions on
//! the webview, and Help.

use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, Wry};
use url::Url;

use crate::{hooks, window};

const RELOAD: &str = "reload";
const FORCE_RELOAD: &str = "force-reload";
const TOGGLE_DEVTOOLS: &str = "toggle-devtools";
const RESET_ZOOM: &str = "reset-zoom";
const ZOOM_IN: &str = "zoom-in";
const ZOOM_OUT: &str = "zoom-out";
const FULLSCREEN: &str = "toggle-fullscreen";
const DOCUMENTATION: &str = "documentation";
const KEYBOARD_SHORTCUTS: &str = "keyboard-shortcuts";
const REPORT_ISSUE: &str = "report-issue";
const QUIT: &str = "quit";

pub const DOCUMENTATION_URL: &str = env!("COGPIT_DOCUMENTATION_URL");
pub const REPORT_ISSUE_URL: &str = env!("COGPIT_REPORT_ISSUE_URL");

/// Zoom steps as Chromium takes them: each level is 20% larger than the last.
const ZOOM_STEP: f64 = 0.5;
const ZOOM_LEVELS: std::ops::RangeInclusive<f64> = -3.0..=5.0;

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let item = |id: &str, label: &str, accelerator: Option<&str>| {
        MenuItem::with_id(app, id, label, true, accelerator)
    };
    let separator = || PredefinedMenuItem::separator(app);
    let mac = cfg!(target_os = "macos");

    let app_menu = if mac {
        Submenu::with_items(
            app,
            "Cogpit",
            true,
            &[
                &PredefinedMenuItem::about(app, None, None)?,
                &separator()?,
                &PredefinedMenuItem::services(app, None)?,
                &separator()?,
                &PredefinedMenuItem::hide(app, None)?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::show_all(app, None)?,
                &separator()?,
                &PredefinedMenuItem::quit(app, None)?,
            ],
        )?
    } else {
        let label = if cfg!(windows) { "Exit" } else { "Quit" };
        Submenu::with_items(
            app,
            "File",
            true,
            &[&item(QUIT, label, Some("CmdOrCtrl+Q"))?],
        )?
    };

    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &separator()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &item(RELOAD, "Reload", Some("CmdOrCtrl+R"))?,
            &item(FORCE_RELOAD, "Force Reload", Some("CmdOrCtrl+Shift+R"))?,
            &item(
                TOGGLE_DEVTOOLS,
                "Toggle Developer Tools",
                Some(if mac { "Alt+Cmd+I" } else { "Ctrl+Shift+I" }),
            )?,
            &separator()?,
            &item(RESET_ZOOM, "Actual Size", Some("CmdOrCtrl+0"))?,
            &item(ZOOM_IN, "Zoom In", Some("CmdOrCtrl+="))?,
            &item(ZOOM_OUT, "Zoom Out", Some("CmdOrCtrl+-"))?,
            &separator()?,
            &item(
                FULLSCREEN,
                "Toggle Full Screen",
                Some(if mac { "Ctrl+Cmd+F" } else { "F11" }),
            )?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?],
    )?;
    if mac {
        window_menu.append(&PredefinedMenuItem::maximize(app, Some("Zoom"))?)?;
    }
    window_menu.append(&PredefinedMenuItem::close_window(app, None)?)?;

    let help = Submenu::with_items(
        app,
        "Help",
        true,
        &[
            &item(DOCUMENTATION, "Documentation", None)?,
            &item(KEYBOARD_SHORTCUTS, "Keyboard Shortcuts", None)?,
            &separator()?,
            &item(REPORT_ISSUE, "Report an Issue", None)?,
        ],
    )?;

    #[cfg(target_os = "macos")]
    {
        window_menu.set_as_windows_menu_for_nsapp()?;
        help.set_as_help_menu_for_nsapp()?;
    }

    Menu::with_items(app, &[&app_menu, &edit, &view, &window_menu, &help])
}

pub fn handle(app: &AppHandle, event: MenuEvent) {
    activate(app, event.id().as_ref());
}

pub fn activate(app: &AppHandle, id: &str) {
    match id {
        DOCUMENTATION => open_url(DOCUMENTATION_URL),
        REPORT_ISSUE => open_url(REPORT_ISSUE_URL),
        KEYBOARD_SHORTCUTS => {
            let window = window::show(app);
            hooks::call(&window, hooks::OPEN_KEYBOARD_SHORTCUTS, None);
        }
        QUIT => app.exit(0),
        id => {
            let Some(window) = app.get_webview_window(window::MAIN) else {
                return;
            };
            match id {
                RELOAD | FORCE_RELOAD => {
                    let _ = window.reload();
                }
                TOGGLE_DEVTOOLS if window.is_devtools_open() => window.close_devtools(),
                TOGGLE_DEVTOOLS => window.open_devtools(),
                RESET_ZOOM | ZOOM_IN | ZOOM_OUT => {
                    let zoom = &app.state::<crate::Shell>().zoom_level;
                    let mut level = zoom.lock().unwrap();
                    *level = next_zoom_level(*level, id);
                    let _ = window.set_zoom(1.2_f64.powf(*level));
                }
                FULLSCREEN => {
                    let fullscreen = window.is_fullscreen().unwrap_or(false);
                    let _ = window.set_fullscreen(!fullscreen);
                }
                _ => {}
            }
        }
    }
}

fn next_zoom_level(level: f64, action: &str) -> f64 {
    let next = match action {
        ZOOM_IN => level + ZOOM_STEP,
        ZOOM_OUT => level - ZOOM_STEP,
        _ => 0.0,
    };
    next.clamp(*ZOOM_LEVELS.start(), *ZOOM_LEVELS.end())
}

fn open_url(url: &str) {
    window::open_external(&Url::parse(url).expect("help links are URLs"));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn help_links_come_from_the_shared_list() {
        assert_eq!(
            DOCUMENTATION_URL,
            "https://github.com/gentritbiba/cogpit#readme"
        );
        assert_eq!(
            REPORT_ISSUE_URL,
            "https://github.com/gentritbiba/cogpit/issues/new"
        );
    }

    #[test]
    fn zooms_in_steps_within_bounds() {
        assert_eq!(next_zoom_level(0.0, ZOOM_IN), 0.5);
        assert_eq!(next_zoom_level(0.5, ZOOM_OUT), 0.0);
        assert_eq!(next_zoom_level(2.0, RESET_ZOOM), 0.0);
        assert_eq!(next_zoom_level(5.0, ZOOM_IN), 5.0);
        assert_eq!(next_zoom_level(-3.0, ZOOM_OUT), -3.0);
    }
}
