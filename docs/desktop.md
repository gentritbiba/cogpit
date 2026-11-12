# Desktop app

The desktop app is a [Tauri](https://tauri.app) shell in `desktop/` (Rust) on
macOS, Linux and Windows. It opens one window and shows the same renderer a
browser gets, served by the local API server on `http://127.0.0.1:<port>`.

```text
desktop/ (Rust)  ──spawns──>  server/desktop.ts on a bundled Bun runtime
   window, menu,               ├─ stdout: {"type":"ready","port":…} | error | notify
   notifications,              └─ stdin:  desktop-presence | notification-clicked | shutdown
   presence, browser           (line-delimited JSON, shared/desktopProtocol.ts)
        │
        └── webview ──HTTP/WS──> the server (every API, the renderer build, WebSockets)
```

## The server sidecar

`server/desktop.ts` starts the shared server composition (`createServerComposition`)
with `--static-dir` and `--data-dir`, binds `127.0.0.1` on an ephemeral port (or
`0.0.0.0:19384` with Network Access on), writes `~/.cogpit/port`, and reports
`ready` on stdout. All logging goes to stderr; stdout carries only protocol lines.

The shell writes presence samples, notification clicks and `shutdown` to the
server's stdin. Closing stdin means the shell is gone: the server saves the
session catalog and exits, so a killed shell never leaves a server behind. On
quit the shell sends `shutdown`, waits up to five seconds, then kills the
server. On Windows the server runs in a job object, which also takes every
process it started.

The data folder is the one Cogpit has always used: `Cogpit` under the
platform's application-data folder (`~/Library/Application Support/Cogpit`,
`%APPDATA%\Cogpit`, `~/.config/Cogpit`). Startup output goes to `startup.log`
(`~/Library/Logs/Cogpit/` on macOS, `<data>/logs/` elsewhere), which the
"Cogpit could not start" dialog points at.

GUI apps do not inherit the login shell's `PATH` on macOS and Linux, so the
shell asks the user's login shell for it (three seconds at most, killing
whatever its startup files left running) and starts the server with it.

A built app ships the Rust core (`cogpit-core`) next to its executable and
passes it to the server as `--core-bin` (the composition's `coreBin`). It is an
argument rather than `COGPIT_CORE_BIN` because everything the server starts
inherits its environment: a Cogpit run from source in one of the app's
terminals would otherwise use the app's core instead of its own build. A dev
build passes nothing, and the server finds the checkout's build
(`bun run build:core`, which `desktop:dev` runs).

## The renderer bridge

`src/desktop/bridge.ts` is the only renderer module that imports
`@tauri-apps/*` (`check:architecture` enforces it). In the desktop app it sets
`window.cogpitDesktop` (`platform`, `performance.getSnapshot()`, `updater`) and the
`desktop desktop-<platform>` classes on `<html>`. Everything else reads
`window.cogpitDesktop`, which a browser leaves undefined. The webview may call
only the commands granted to the server's origin at runtime
(`performance_snapshot`, the three `update_*` commands, window dragging);
sandboxed plugin and view frames get nothing.

On macOS the title bar is hidden under the traffic lights. `.desktop-drag`
regions and the `.drag-strip` above the chat pane drag the window, and
`.window-inset-start` leaves room for the traffic lights. Windows and Linux keep
the native title bar.

The shell calls two renderer hooks with retries, so a booting renderer does not
drop them: `__cogpitRevealSession(path)` after a notification click, and
`__cogpitOpenKeyboardShortcuts()` from Help → Keyboard Shortcuts.

## Navigation

The window only shows the server's origin. A link anywhere else, or
`window.open`, opens in the system browser (http and https without
credentials only). macOS and Linux report navigations of every frame without
saying which, so a cross-origin frame navigation is treated the same way; the
server's CSP keeps frames on the app origin, and it refuses a frame navigating
anywhere but a plugin or view shell.

## Develop and build

```bash
bun run desktop:dev     # Vite (renderer only) + the shell, server from source on your Bun
bun run desktop:build   # renderer + bundled server + app bundle in desktop/target/release/bundle
bun scripts/desktop.ts stage   # only the renderer and server bundle (desktop/resources/)
```

Both need Rust (`rustup`). Linux also needs the WebKitGTK development
packages (`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `librsvg2-dev`,
`libayatana-appindicator3-dev`, `libssl-dev`).

A built app carries `resources/server/desktop.js` (the server bundled by
`Bun.build`), `resources/server/instance-worker.js`,
`resources/web/` (the renderer) and the Bun runtime as `cogpit-bun` next to the
app executable. A dev build runs `server/desktop.ts` from source with the `bun`
on your PATH and the renderer from `bun run desktop:dev`'s Vite (or `dist/`).

`desktop:build` always ships the same Bun (`BUN_VERSION` in
`scripts/desktop.ts`, downloaded and checked against its SHA-256 when the Bun
running the build is another version). `bun run desktop:update` builds this
checkout and installs it over `/Applications/Cogpit.app` once Cogpit has quit
(macOS). It refuses a build without `cogpit-bun`, `cogpit-core` or the server
bundle, and marks the app with `local-build.json` so the updater leaves it alone.

## Updates

The shell checks for a new version five seconds after start and every six
hours (`desktop/src/updater.rs`), downloads it in the background, and reports
one state the renderer shows as a banner (`window.cogpitDesktop.updater`,
`UpdateBanner`). How an install updates depends on what it is:

| Install | Update |
|---|---|
| macOS app in a writable folder, Windows installer, Linux AppImage | `tauri-plugin-updater` replaces it on "Restart now" or on the next quit |
| pacman package | the same signed download, installed with `pkexec pacman -U` on "Restart now" only |
| macOS app on a read-only or translocated path, deb | a notice with a link to the release, or "update through your package manager" |
| `bun run desktop:update` build, unbundled binary | nothing |

Every update file is signed with a minisign key. The public half is in
`desktop/tauri.conf.json` (`plugins.updater.pubkey`); the app installs nothing
that key did not sign. The manifest is `latest.json` on the latest GitHub
release. `COGPIT_UPDATE_FEED_URL` points an app at another folder holding
`latest.json` (https only in a release build).

## Releases

A `v*` tag runs `.github/workflows/release.yml`:

1. `core` builds `cogpit-core` for macOS arm64 and x64, Linux x64 and arm64
   (static musl binaries, so they run on any distro) and Windows x64.
2. `desktop` runs `bun run desktop:build` on each platform with that core
   (`COGPIT_CORE_PREBUILT`), then `scripts/release-artifacts.ts collect` names
   the files: a dmg and an `.app.tar.gz` per macOS architecture, an AppImage and
   a pacman package (repacked from the deb, `scripts/lib/pacmanPackage.ts`), and
   the Windows installer. Linux builds on Ubuntu 22.04 so the app needs no newer
   glibc.
3. `assemble` writes `latest.json` and checks the release holds exactly the
   expected files. `publish` uploads them; `publish-npm` ships the `cogpit`
   launcher with every platform's core in `dist/core/<platform>-<arch>/`;
   `update-aur` pushes both AUR packages.

Dispatching the workflow by hand is a dry run that publishes nothing. On a
branch it builds the public edition and signs with a throwaway key.

The `release` environment needs two secrets, or a tag build stops before it
builds anything: `TAURI_SIGNING_PRIVATE_KEY` (the contents of the private key
file) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Losing the key means no
existing install can update again, so keep a copy outside GitHub.

macOS builds are ad-hoc signed (`signingIdentity: "-"`), which is why the first
open of a downloaded dmg needs right-click → Open. To ship Developer ID builds,
add `APPLE_SIGNING_IDENTITY` (plus Tauri's `APPLE_CERTIFICATE`,
`APPLE_CERTIFICATE_PASSWORD` and, for notarization, `APPLE_ID`,
`APPLE_PASSWORD`, `APPLE_TEAM_ID`) to the `release` environment and pass them
to the build step; nothing else changes.

## Moving Electron installs

Cogpit up to 3.6.x was an Electron app with its own updater. While
`COGPIT_ELECTRON_BRIDGE` is `"1"` in `release.yml`, a release also publishes
what that updater reads, so those installs update themselves to this app and
keep their data (the data folder never moved):

- **macOS**: `latest-mac.yml` and a zip per architecture. The old updater only
  accepts a bundle with `Contents/Resources/app.asar`, so the bundle carries a
  placeholder file of that name (`desktop/electron-bridge/app.asar`).
- **Windows**: `latest.yml`. The old updater runs the new installer silently;
  its hooks (`desktop/windows/installer-hooks.nsh`) run the Electron install's
  uninstaller first, keeping `%APPDATA%\Cogpit`, and start the app afterwards.
- **Linux**: `latest-linux.yml`. The AppImage is replaced in place. The pacman
  package keeps the name `cogpit` and the `/opt/Cogpit/cogpit` executable, and
  makes the `/usr/bin/cogpit` link in its install script, because the old
  package left an unowned link there that pacman would refuse to overwrite.

An install that never updates while the bridge is on stays on Electron until
its user downloads the app again. Turning the bridge off removes the zips, the
three `latest*.yml` files and the placeholder.
