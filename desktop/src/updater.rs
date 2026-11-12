//! In-app updates. The shell checks the release feed, downloads and verifies
//! the package for this install, and reports one [`UpdateState`] the renderer
//! shows as a banner (`window.cogpitDesktop.updater`).
//!
//! - macOS app bundle, Windows installer, Linux AppImage: `tauri-plugin-updater`
//!   replaces the install.
//! - pacman package: the same signed download, installed with `pkexec pacman -U`
//!   when the user restarts, because it asks for a password.
//! - anything Cogpit cannot replace (a deb, a read-only or translocated bundle):
//!   a notice pointing at the release or the package manager.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use std::{env, fs, thread};

use serde::{Deserialize, Serialize};
use tauri::utils::config::BundleType;
use tauri::utils::platform::bundle_type;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

const RELEASES_URL: &str = "https://github.com/gentritbiba/cogpit/releases";
/// Points the updater at another folder holding `latest.json`, e.g. a mirror.
const FEED_OVERRIDE: &str = "COGPIT_UPDATE_FEED_URL";
const MANIFEST: &str = "latest.json";
const FIRST_CHECK: Duration = Duration::from_secs(5);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const PREFERENCES_FILE: &str = "update-preferences.json";
/// Written into the resources of a pacman package (`scripts/build-pacman.ts`).
const PACKAGE_TYPE_FILE: &str = "package-type";
/// Written into the resources of a build installed by `bun run desktop:update`.
const LOCAL_BUILD_FILE: &str = "local-build.json";
pub const STATE_EVENT: &str = "update-state";

/// Mirrors `DesktopUpdateState` in `src/types/cogpit-desktop.d.ts`.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum UpdateState {
    #[default]
    Idle,
    Available {
        version: String,
        url: String,
        via: Via,
    },
    Ready {
        version: String,
        #[serde(rename = "asksForPassword")]
        asks_for_password: bool,
    },
    Failed {
        version: String,
        message: String,
        url: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Via {
    Download,
    PackageManager,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Installer {
    /// The updater plugin replaces the app bundle, runs the installer or swaps the AppImage.
    Plugin,
    Pacman,
    /// Cogpit cannot replace this install; it only says where the new version is.
    Notice(Via),
}

/// What decides how this install updates.
struct Install<'a> {
    os: &'a str,
    bundle: Option<BundleType>,
    package_type: Option<&'a str>,
    local_build: bool,
    /// macOS: the running bundle can be swapped in place.
    replaceable: bool,
}

fn installer_for(install: &Install) -> Option<Installer> {
    if install.local_build {
        return None;
    }
    match (install.os, &install.bundle) {
        ("macos", Some(BundleType::App)) if install.replaceable => Some(Installer::Plugin),
        ("macos", Some(BundleType::App)) => Some(Installer::Notice(Via::Download)),
        ("windows", Some(BundleType::Nsis)) => Some(Installer::Plugin),
        ("linux", _) if install.package_type == Some("pacman") => Some(Installer::Pacman),
        ("linux", Some(BundleType::AppImage)) => Some(Installer::Plugin),
        ("linux", Some(BundleType::Deb | BundleType::Rpm)) => {
            Some(Installer::Notice(Via::PackageManager))
        }
        // An unbundled binary (`desktop:build --no-bundle`, `cargo run`) is nobody's install.
        _ => None,
    }
}

/// The `.app` holding this executable, when it sits where an install does.
#[cfg(any(unix, test))]
fn app_bundle(executable: &Path) -> Option<PathBuf> {
    let bundle = executable.parent()?.parent()?.parent()?;
    let installed = bundle.extension().is_some_and(|ext| ext == "app")
        && !bundle.starts_with("/Volumes")
        && !bundle
            .components()
            .any(|part| part.as_os_str() == "AppTranslocation");
    installed.then(|| bundle.to_path_buf())
}

#[cfg(target_os = "macos")]
fn writable(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: `path` is a NUL-terminated string that outlives the call.
    unsafe { libc::access(path.as_ptr(), libc::W_OK) == 0 }
}

fn this_install(app: &AppHandle) -> Option<Installer> {
    let resources = app.path().resource_dir().ok();
    let resource = |name: &str| resources.as_ref().map(|dir| dir.join(name));
    let package_type = resource(PACKAGE_TYPE_FILE).and_then(|path| fs::read_to_string(path).ok());
    #[cfg(target_os = "macos")]
    let replaceable = env::current_exe()
        .ok()
        .and_then(|exe| app_bundle(&exe))
        .is_some_and(|bundle| writable(&bundle) && bundle.parent().is_some_and(writable));
    #[cfg(not(target_os = "macos"))]
    let replaceable = false;
    installer_for(&Install {
        os: env::consts::OS,
        // The AppImage runtime sets APPIMAGE; without it there is no file to replace.
        bundle: bundle_type()
            .filter(|bundle| *bundle != BundleType::AppImage || env::var_os("APPIMAGE").is_some()),
        package_type: package_type.as_deref().map(str::trim),
        local_build: resource(LOCAL_BUILD_FILE).is_some_and(|path| path.exists()),
        replaceable,
    })
}

struct Staged {
    update: Update,
    package: PathBuf,
    installer: Installer,
}

#[derive(Default)]
pub struct Updates {
    state: Mutex<UpdateState>,
    staged: Mutex<Option<Staged>>,
}

fn set_state(app: &AppHandle, next: UpdateState) {
    *app.state::<Updates>().state.lock().unwrap() = next.clone();
    let _ = app.emit(STATE_EVENT, next);
}

fn release_url(version: &str) -> String {
    format!("{RELEASES_URL}/tag/v{version}")
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preferences {
    dismissed_version: Option<String>,
}

fn preferences_path(app: &AppHandle) -> Option<PathBuf> {
    crate::data_dir(app)
        .ok()
        .map(|dir| dir.join(PREFERENCES_FILE))
}

fn dismissed_version(path: &Path) -> Option<String> {
    let preferences: Preferences = serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
    preferences.dismissed_version
}

fn announce(app: &AppHandle, version: &str, via: Via) {
    let dismissed = preferences_path(app).and_then(|path| dismissed_version(&path));
    if dismissed.as_deref() == Some(version) {
        return;
    }
    set_state(
        app,
        UpdateState::Available {
            version: version.to_owned(),
            url: release_url(version),
            via,
        },
    );
}

#[tauri::command]
pub fn update_state(updates: State<'_, Updates>) -> UpdateState {
    updates.state.lock().unwrap().clone()
}

#[tauri::command]
pub fn update_dismiss(app: AppHandle, version: String) {
    let Some(path) = preferences_path(&app) else {
        return;
    };
    let preferences = Preferences {
        dismissed_version: Some(version),
    };
    if let Ok(json) = serde_json::to_string_pretty(&preferences) {
        let _ = fs::write(path, json);
    }
}

/// Install the staged update and start the new version. A failure leaves the
/// app running and shows in the banner.
#[tauri::command(async)]
pub fn update_install(app: AppHandle) {
    let Some(staged) = app.state::<Updates>().staged.lock().unwrap().take() else {
        return;
    };
    let version = staged.update.version.clone();
    match install(&staged, true) {
        Ok(()) => {
            let _ = fs::remove_file(&staged.package);
            relaunch_after_exit();
            app.exit(0);
        }
        Err(message) => {
            eprintln!("[updater] Installing {version} failed: {message}");
            let _ = fs::remove_file(&staged.package);
            set_state(
                &app,
                UpdateState::Failed {
                    url: release_url(&version),
                    version,
                    message,
                },
            );
        }
    }
}

/// The app is quitting with an update downloaded: install it for the next
/// start. Not the pacman package, whose password prompt would appear unasked.
pub fn install_on_exit(app: &AppHandle) {
    let Some(staged) = app.state::<Updates>().staged.lock().unwrap().take() else {
        return;
    };
    if staged.installer == Installer::Plugin
        && let Err(message) = install(&staged, false)
    {
        eprintln!(
            "[updater] Installing {} on quit failed: {message}",
            staged.update.version
        );
    }
    let _ = fs::remove_file(&staged.package);
}

/// On Windows a successful install does not return: the installer takes over
/// and the plugin exits the process, restarting the app when `relaunch`.
fn install(staged: &Staged, relaunch: bool) -> Result<(), String> {
    let package = fs::read(&staged.package).map_err(|error| error.to_string())?;
    match staged.installer {
        Installer::Pacman => {
            staged
                .update
                .verify(&package)
                .map_err(|error| error.to_string())?;
            install_with_pacman(&staged.package)
        }
        _ => staged
            .update
            .clone()
            .restart_after_install(relaunch)
            .install(package)
            .map_err(|error| error.to_string()),
    }
}

fn install_with_pacman(package: &Path) -> Result<(), String> {
    let output = std::process::Command::new("pkexec")
        .args(["pacman", "-U", "--noconfirm"])
        .arg(package)
        .output()
        .map_err(|error| format!("pkexec could not be started: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let reason = String::from_utf8_lossy(&output.stderr);
    let reason = reason.lines().rev().find(|line| !line.trim().is_empty());
    Err(match reason {
        Some(line) => format!("pacman could not install the update: {}", line.trim()),
        None => format!("pacman could not install the update ({}).", output.status),
    })
}

/// Waits for a process to end, then runs a command in its place.
#[cfg(unix)]
const WAIT_THEN_RUN: &str = r#"pid=$1; shift; i=0
while kill -0 "$pid" 2>/dev/null; do i=$((i + 1)); [ "$i" -gt 300 ] && exit 1; sleep 0.2; done
exec "$@""#;

/// A detached shell that runs `launch` once process `pid` has exited.
#[cfg(unix)]
fn run_after_exit(pid: u32, launch: &[std::ffi::OsString]) -> std::process::Command {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    let mut waiter = Command::new("/bin/sh");
    waiter
        .args(["-c", WAIT_THEN_RUN, "cogpit-relaunch"])
        .arg(pid.to_string())
        .args(launch)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0);
    waiter
}

/// Start the installed version once this process is gone; the single-instance
/// lock would turn away a copy started any sooner. Windows needs none of this:
/// its installer restarts the app.
fn relaunch_after_exit() {
    #[cfg(unix)]
    {
        let Ok(executable) = env::current_exe() else {
            return;
        };
        let launch = match app_bundle(&executable) {
            Some(bundle) if cfg!(target_os = "macos") => {
                vec!["/usr/bin/open".into(), bundle.into_os_string()]
            }
            _ => vec![env::var_os("APPIMAGE").unwrap_or(executable.into_os_string())],
        };
        if let Err(error) = run_after_exit(std::process::id(), &launch).spawn() {
            eprintln!("[updater] Cogpit could not arrange its restart: {error}");
        }
    }
}

fn package_path(app: &AppHandle, installer: Installer) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("update");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }
    Ok(dir.join(match installer {
        Installer::Pacman => "cogpit-update.pkg.tar.zst",
        _ => "cogpit-update",
    }))
}

fn feed_override() -> Result<Option<Url>, String> {
    let Some(feed) = env::var(FEED_OVERRIDE)
        .ok()
        .filter(|feed| !feed.trim().is_empty())
    else {
        return Ok(None);
    };
    let base = if feed.ends_with('/') {
        feed
    } else {
        format!("{feed}/")
    };
    Url::parse(&base)
        .and_then(|base| base.join(MANIFEST))
        .map(Some)
        .map_err(|error| format!("{FEED_OVERRIDE} is not a URL: {error}"))
}

async fn check(app: &AppHandle, installer: Installer) -> Result<(), String> {
    let mut builder = app.updater_builder();
    if let Some(feed) = feed_override()? {
        builder = builder
            .endpoints(vec![feed])
            .map_err(|error| error.to_string())?;
    }
    if installer == Installer::Pacman
        && let Some(target) = tauri_plugin_updater::target()
    {
        builder = builder.target(format!("{target}-pacman"));
    }
    // The Windows installer starts while the app is still up, and the plugin then
    // exits the process without the shell's own teardown.
    let quitting = app.clone();
    builder = builder.on_before_exit(move || crate::stop_server(&quitting));

    let updater = builder.build().map_err(|error| error.to_string())?;
    let Some(update) = updater.check().await.map_err(|error| error.to_string())? else {
        return Ok(());
    };
    let version = update.version.clone();
    let updates = app.state::<Updates>();
    let already_staged = updates
        .staged
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|staged| staged.update.version == version);
    if already_staged {
        return Ok(());
    }
    if let Installer::Notice(via) = installer {
        announce(app, &version, via);
        return Ok(());
    }

    let staged = async {
        let package = update
            .download(|_, _| {}, || {})
            .await
            .map_err(|error| error.to_string())?;
        let path = package_path(app, installer)?;
        fs::write(&path, package).map_err(|error| error.to_string())?;
        Ok::<_, String>(path)
    }
    .await;
    match staged {
        Ok(package) => {
            *updates.staged.lock().unwrap() = Some(Staged {
                update,
                package,
                installer,
            });
            set_state(
                app,
                UpdateState::Ready {
                    version,
                    asks_for_password: installer == Installer::Pacman,
                },
            );
            Ok(())
        }
        Err(error) => {
            announce(app, &version, Via::Download);
            Err(error)
        }
    }
}

/// Check shortly after start and every few hours, for as long as the app runs.
pub fn start(app: &AppHandle) {
    let Some(installer) = this_install(app) else {
        return;
    };
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(FIRST_CHECK);
        loop {
            // Usually offline or a release without a manifest; the next round retries.
            if let Err(error) = tauri::async_runtime::block_on(check(&app, installer)) {
                eprintln!("[updater] Update check failed: {error}");
            }
            thread::sleep(CHECK_INTERVAL);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn install(os: &'static str, bundle: Option<BundleType>) -> Install<'static> {
        Install {
            os,
            bundle,
            package_type: None,
            local_build: false,
            replaceable: true,
        }
    }

    #[test]
    fn serializes_the_states_the_renderer_reads() {
        let json = |state: UpdateState| serde_json::to_value(state).unwrap();
        assert_eq!(
            json(UpdateState::Idle),
            serde_json::json!({ "status": "idle" })
        );
        assert_eq!(
            json(UpdateState::Available {
                version: "4.0.0".into(),
                url: release_url("4.0.0"),
                via: Via::PackageManager,
            }),
            serde_json::json!({
                "status": "available",
                "version": "4.0.0",
                "url": "https://github.com/gentritbiba/cogpit/releases/tag/v4.0.0",
                "via": "package-manager",
            })
        );
        assert_eq!(
            json(UpdateState::Ready {
                version: "4.0.0".into(),
                asks_for_password: true
            }),
            serde_json::json!({ "status": "ready", "version": "4.0.0", "asksForPassword": true })
        );
        assert_eq!(
            json(UpdateState::Failed {
                version: "4.0.0".into(),
                message: "no".into(),
                url: "u".into()
            }),
            serde_json::json!({ "status": "failed", "version": "4.0.0", "message": "no", "url": "u" })
        );
    }

    #[test]
    fn picks_how_each_install_updates() {
        let plugin = Some(Installer::Plugin);
        assert_eq!(
            installer_for(&install("macos", Some(BundleType::App))),
            plugin
        );
        assert_eq!(
            installer_for(&install("windows", Some(BundleType::Nsis))),
            plugin
        );
        assert_eq!(
            installer_for(&install("linux", Some(BundleType::AppImage))),
            plugin
        );
        assert_eq!(
            installer_for(&install("linux", Some(BundleType::Deb))),
            Some(Installer::Notice(Via::PackageManager))
        );
        // The pacman package carries the deb build of the binary.
        assert_eq!(
            installer_for(&Install {
                package_type: Some("pacman"),
                ..install("linux", Some(BundleType::Deb))
            }),
            Some(Installer::Pacman)
        );
    }

    #[test]
    fn only_points_at_the_release_when_the_bundle_cannot_be_replaced() {
        assert_eq!(
            installer_for(&Install {
                replaceable: false,
                ..install("macos", Some(BundleType::App))
            }),
            Some(Installer::Notice(Via::Download))
        );
    }

    #[test]
    fn leaves_local_and_unbundled_builds_alone() {
        assert_eq!(installer_for(&install("linux", None)), None);
        assert_eq!(installer_for(&install("windows", None)), None);
        assert_eq!(
            installer_for(&Install {
                local_build: true,
                ..install("macos", Some(BundleType::App))
            }),
            None
        );
    }

    #[test]
    fn finds_the_bundle_of_an_installed_app_only() {
        let bundle = |path: &str| app_bundle(Path::new(path));
        assert_eq!(
            bundle("/Applications/Cogpit.app/Contents/MacOS/Cogpit"),
            Some(PathBuf::from("/Applications/Cogpit.app"))
        );
        assert_eq!(
            bundle("/Volumes/Cogpit/Cogpit.app/Contents/MacOS/Cogpit"),
            None
        );
        assert_eq!(
            bundle(
                "/private/var/folders/x/AppTranslocation/1234/d/Cogpit.app/Contents/MacOS/Cogpit"
            ),
            None
        );
        assert_eq!(bundle("/repo/desktop/target/release/Cogpit"), None);
    }

    #[cfg(unix)]
    #[test]
    fn restarts_only_after_the_old_process_has_gone() {
        use std::process::Command;
        let marker = env::temp_dir().join(format!("cogpit-relaunch-test-{}", std::process::id()));
        let _ = fs::remove_file(&marker);
        let mut old = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let launch = ["/usr/bin/touch".into(), marker.clone().into_os_string()];
        let mut waiter = run_after_exit(old.id(), &launch).spawn().unwrap();

        thread::sleep(Duration::from_millis(600));
        assert!(!marker.exists(), "started while the old process was alive");

        old.kill().unwrap();
        old.wait().unwrap();
        assert!(waiter.wait().unwrap().success());
        assert!(marker.exists());
        fs::remove_file(marker).unwrap();
    }

    #[test]
    fn remembers_the_version_the_user_dismissed() {
        let dir = env::temp_dir().join(format!("cogpit-updater-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(PREFERENCES_FILE);
        assert_eq!(dismissed_version(&path), None);
        // The file the Electron app wrote.
        fs::write(&path, "{\n  \"dismissedVersion\": \"3.6.1\"\n}").unwrap();
        assert_eq!(dismissed_version(&path), Some("3.6.1".to_owned()));
        fs::remove_dir_all(dir).unwrap();
    }
}
