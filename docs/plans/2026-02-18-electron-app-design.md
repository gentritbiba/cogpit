# Cogpit Electron App Design

## Goal

Package Cogpit as a standalone desktop app (macOS, Windows, Linux) so users can download and run it without cloning a repo. The existing web version (`bun dev`) remains fully functional and unchanged.

## Key Decisions

- **Bridge layer**: Embedded HTTP/WS server inside Electron's main process. The React frontend makes the same `fetch()`/`EventSource`/`WebSocket` calls — zero changes to `src/`.
- **Build tooling**: `electron-vite` for dev + build, `electron-builder` for packaging.
- **Auth**: Uses the user's existing `claude` CLI installation. No API keys or login flow in the app.
- **Platforms**: macOS (.dmg), Windows (.exe/NSIS), Linux (.AppImage/.deb).

## Project Structure

```
cogpit/
├── src/                    # Shared React frontend (NO changes)
├── server/
│   ├── api-plugin.ts       # Vite plugin (web-only, unchanged)
│   ├── pty-plugin.ts       # Vite plugin (web-only, unchanged)
│   └── config.ts           # Shared config logic (used by both)
├── electron/
│   ├── main.ts             # Electron main process entry
│   ├── server.ts           # Embedded HTTP/WS server
│   └── preload.ts          # Minimal preload script
├── vite.config.ts          # Web version config (unchanged)
├── electron.vite.config.ts # Electron build config
├── package.json            # Adds electron scripts + deps
└── electron-builder.yml    # Packaging config (all 3 platforms)
```

## Electron Main Process

`electron/main.ts` does three things on launch:

1. Starts the embedded HTTP/WS server on a random available port.
2. Creates a `BrowserWindow` that loads the Vite-built frontend pointed at that local server.
3. Handles app lifecycle (quit on all windows closed for Windows/Linux, dock behavior for macOS).

`electron/server.ts` is a standalone Express server that:

- Mounts the same REST endpoints from `api-plugin.ts` (session listing, file reads, config, undo/redo).
- Mounts the same WebSocket server from `pty-plugin.ts` (PTY sessions).
- Serves the static Vite build output (`dist/`) for the renderer.
- Imports `server/config.ts` directly for shared config logic.

## Build & Packaging

### Scripts

- `bun dev` — web version, exactly as today.
- `bun electron:dev` — electron-vite starts main process + Vite dev server with hot reload.
- `bun electron:build` — compiles main + renderer, then electron-builder packages the app.

### New Dependencies

- `electron` — runtime
- `electron-vite` — build tooling
- `electron-builder` — packaging
- `express` — embedded HTTP server in main process
- `electron-rebuild` — rebuilds `node-pty` for Electron's Node version

## Error Handling

- **`claude` CLI not found**: Check `PATH` on startup. Show friendly message if missing. Session browsing still works, but can't start new sessions or chat.
- **Port conflicts**: Server picks a random available port (port 0). No hardcoded ports.
- **Cross-platform paths**: `server/config.ts` already uses `homedir()` + `path.join()`. Works on all platforms.
- **`node-pty` rebuild**: `electron-rebuild` runs as postinstall. Same approach VS Code uses.

## What Stays Unchanged

- All React code in `src/`
- Vite plugins in `server/` (used by web mode only)
- `bun dev` and `bun build` for the web version
- No new auth flows — relies on user's existing `claude` CLI
