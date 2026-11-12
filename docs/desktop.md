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

When a `cogpit-core` binary sits next to the shell's executable, the shell
passes its path to the server as `COGPIT_CORE_BIN`.

## The renderer bridge

`src/desktop/bridge.ts` is the only renderer module that imports
`@tauri-apps/*` (`check:architecture` enforces it). In the desktop app it sets
`window.cogpitDesktop` (`platform`, `performance.getSnapshot()`) and the
`desktop desktop-<platform>` classes on `<html>`. Everything else reads
`window.cogpitDesktop`, which a browser leaves undefined. The webview may call
only the commands granted to the server's origin at runtime
(`performance_snapshot`, window dragging); sandboxed plugin and view frames get
nothing.

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
`Bun.build`), `resources/server/instance-worker.js`, node-pty for the platform,
`resources/web/` (the renderer) and the Bun runtime as `cogpit-bun` next to the
app executable. A dev build runs `server/desktop.ts` from source with the `bun`
on your PATH and the renderer from `bun run desktop:dev`'s Vite (or `dist/`).

Signing, updates, the release workflow and moving existing installs to this
app are handled with packaging, not here.
