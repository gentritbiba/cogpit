//! Cogpit's desktop shell: one window on the local API server, which runs as a
//! sidecar process (`server/desktop.ts`), plus the native parts the server
//! cannot reach: menu, notifications, presence and the system browser.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod hooks;
mod menu;
mod navigation;
mod notifications;
mod performance;
mod presence;
mod protocol;
mod shell_path;
mod sidecar;
mod startup_log;
mod window;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use std::{env, thread};

use tauri::ipc::CapabilityBuilder;
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use url::Url;

use crate::protocol::ShellMessage;
use crate::sidecar::{Launch, Sidecar, Startup};
use crate::startup_log::StartupLog;

/// Idle time changes without emitting events, so presence is re-sampled.
const PRESENCE_POLL: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct Shell {
    /// The server's origin, once it is listening; until then the window shows the loading page.
    origin: Mutex<Option<Url>>,
    server: Mutex<Option<Arc<Sidecar>>>,
    quitting: AtomicBool,
    zoom_level: Mutex<f64>,
    presence: OnceLock<mpsc::Sender<WindowState>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum WindowState {
    Unchanged,
    /// Sent from the window's destroyed event, which fires before the window leaves the app's list.
    Closed,
}

impl Shell {
    fn origin(&self) -> Option<Url> {
        self.origin.lock().unwrap().clone()
    }

    fn server(&self) -> Option<Arc<Sidecar>> {
        self.server.lock().unwrap().clone()
    }

    fn server_pid(&self) -> Option<u32> {
        self.server().map(|server| server.pid())
    }
}

pub fn send_to_server(app: &AppHandle, message: &ShellMessage) {
    if let Some(server) = app.state::<Shell>().server() {
        server.send(message);
    }
}

/// Tell the server what the shell can see of the user's presence, after an event that may have changed it.
pub fn presence_changed(app: &AppHandle, window: WindowState) {
    if let Some(reporter) = app.state::<Shell>().presence.get() {
        let _ = reporter.send(window);
    }
}

/// One thread samples presence, off the event loop: when woken by an event, and
/// every [`PRESENCE_POLL`] because walking away produces no event at all.
/// A burst of events becomes one sample.
fn start_presence_reporting(app: AppHandle) {
    let (sender, events) = mpsc::channel();
    let _ = app.state::<Shell>().presence.set(sender);
    thread::spawn(move || {
        loop {
            let mut closed = match events.recv_timeout(PRESENCE_POLL) {
                Ok(window) => window == WindowState::Closed,
                Err(RecvTimeoutError::Timeout) => false,
                Err(RecvTimeoutError::Disconnected) => return,
            };
            while let Ok(window) = events.try_recv() {
                closed |= window == WindowState::Closed;
            }
            let has_window = !closed && app.get_webview_window(window::MAIN).is_some();
            send_to_server(
                &app,
                &ShellMessage::DesktopPresence {
                    has_window,
                    locked: presence::screen_locked(),
                    idle_seconds: presence::idle_seconds(),
                },
            );
        }
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            window::show(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(Shell::default())
        .manage(performance::Sampler::default())
        .menu(menu::build)
        .on_menu_event(menu::handle)
        .invoke_handler(tauri::generate_handler![performance::performance_snapshot])
        .setup(|app| {
            let app = app.handle().clone();
            notifications::init(&app);
            start_presence_reporting(app.clone());
            // Show the window straight away; the server can take seconds to start.
            window::create(&app);
            thread::spawn(move || start_server(&app));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("build the Cogpit shell")
        .run(|app, event| match event {
            // macOS apps stay open with no windows; the dock icon opens a new one.
            RunEvent::ExitRequested {
                code: None, api, ..
            } if cfg!(target_os = "macos") => api.prevent_exit(),
            #[cfg(target_os = "macos")]
            RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } => {
                window::show(app);
            }
            RunEvent::Exit => {
                let shell = app.state::<Shell>();
                shell.quitting.store(true, Ordering::SeqCst);
                shell_path::abandon();
                let server = shell.server.lock().unwrap().take();
                if let Some(server) = server {
                    server.shut_down();
                }
            }
            _ => {}
        });
}

fn start_server(app: &AppHandle) {
    let shell = app.state::<Shell>();
    let login_shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_owned());
    let path = shell_path::login_shell_path(&login_shell, shell_path::TIMEOUT);
    if shell.quitting.load(Ordering::SeqCst) {
        return;
    }

    let log = Arc::new(StartupLog::open(&logs_dir(app)));
    let started = launch(app, path).and_then(|launch| {
        let notifying = app.clone();
        let on_notify = move |notify| notifications::present(&notifying, notify);
        Sidecar::spawn(&launch, log.clone(), on_notify)
            .map_err(|error| format!("The server could not be started: {error}"))
    });
    let outcome = started.and_then(|(server, startup)| {
        *shell.server.lock().unwrap() = Some(server);
        match startup.recv_timeout(sidecar::START_TIMEOUT) {
            Ok(Startup::Ready(port)) => Ok(port),
            Ok(Startup::Failed(reason)) => Err(reason),
            Err(_) => Err(format!(
                "The server did not start within {} seconds.",
                sidecar::START_TIMEOUT.as_secs()
            )),
        }
    });
    log.close();

    let port = match outcome {
        Ok(port) => port,
        Err(reason) => return fail_startup(app, &reason, log.path.as_deref()),
    };
    eprintln!("[shell] Cogpit server ready on port {port}");
    let origin =
        Url::parse(&format!("http://127.0.0.1:{port}")).expect("a loopback origin is a URL");
    let allowed = CapabilityBuilder::new("app")
        .remote(origin.origin().ascii_serialization())
        .window(window::MAIN)
        .permission("allow-performance-snapshot")
        .permission("core:window:allow-start-dragging")
        .permission("core:window:allow-toggle-maximize");
    if let Err(error) = app.add_capability(allowed) {
        return fail_startup(
            app,
            &format!("The app could not trust its server: {error}"),
            None,
        );
    }
    *shell.origin.lock().unwrap() = Some(origin.clone());
    window::open_app(app, &origin);
    presence_changed(app, WindowState::Unchanged);
}

fn fail_startup(app: &AppHandle, reason: &str, log: Option<&std::path::Path>) {
    eprintln!("[shell] Cogpit could not start: {reason}");
    // Quitting mid-start ends the server, which is not a failure to report.
    if !app.state::<Shell>().quitting.load(Ordering::SeqCst) {
        let mut dialog = app
            .dialog()
            .message(startup_log::failure_message(reason, log))
            .title("Cogpit could not start")
            .kind(MessageDialogKind::Error);
        // Attached to the window, so it shows wherever the loading page is.
        if let Some(window) = app.get_webview_window(window::MAIN) {
            dialog = dialog.parent(&window);
        }
        dialog.blocking_show();
    }
    app.exit(1);
}

/// Where the server, its runtime and the renderer are. A development build
/// runs the server from source on the developer's own Bun, with the renderer
/// from `bun run desktop:dev`'s Vite or from `dist/`.
fn launch(app: &AppHandle, path: Option<String>) -> Result<Launch, String> {
    let executable_dir = env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(PathBuf::from))
        .ok_or("The app cannot find its own folder.")?;
    let (runtime, script, static_dir) = if cfg!(debug_assertions) {
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        (
            PathBuf::from("bun"),
            repo.join("server/desktop.ts"),
            repo.join("dist"),
        )
    } else {
        let resources = app
            .path()
            .resource_dir()
            .map_err(|error| format!("The app cannot find its resources: {error}"))?;
        (
            executable_dir.join(format!("cogpit-bun{}", env::consts::EXE_SUFFIX)),
            resources.join("server/desktop.js"),
            resources.join("web"),
        )
    };
    let core = executable_dir.join(format!("cogpit-core{}", env::consts::EXE_SUFFIX));
    Ok(Launch {
        runtime,
        script,
        static_dir,
        data_dir: data_dir(app)?,
        path,
        core_bin: core.is_file().then_some(core),
    })
}

/// The folder Cogpit has always kept its data in: `Cogpit` under the platform's
/// application-data folder, not one named after the bundle identifier.
fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .config_dir()
        .map(|dir| dir.join("Cogpit"))
        .map_err(|error| format!("The app cannot find its data folder: {error}"))
}

fn logs_dir(app: &AppHandle) -> PathBuf {
    if cfg!(target_os = "macos")
        && let Ok(home) = app.path().home_dir()
    {
        return home.join("Library/Logs/Cogpit");
    }
    data_dir(app)
        .unwrap_or_else(|_| env::temp_dir().join("Cogpit"))
        .join("logs")
}
