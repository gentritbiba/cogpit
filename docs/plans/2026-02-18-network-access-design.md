# Network Access for Cogpit

**Date:** 2026-02-18
**Status:** Approved

## Summary

Allow Cogpit's embedded server to be accessed from other devices on the local network. When enabled, the server binds to `0.0.0.0` with a fixed port and requires a user-configured password for remote clients. Local clients (`127.0.0.1`) bypass auth entirely.

## Requirements

- **Opt-in via settings toggle** — disabled by default, server stays on `127.0.0.1`
- **User-configured password** — persisted in config, required when network access is on
- **Full access for authenticated clients** — same capabilities as local (sessions, terminals, undo, etc.)
- **Connection URL in header** — shown when enabled, clickable to copy
- **Works in both Electron and Vite dev mode**

## Design

### 1. Config Extension

Extend `AppConfig` in `server/config.ts`:

```ts
interface AppConfig {
  claudeDir: string
  networkAccess?: boolean   // default false
  networkPassword?: string  // required when networkAccess is true
}
```

Persisted in the existing `config.local.json`. The `saveConfig` and `loadConfig` functions already handle this file — just pass the new fields through.

### 2. Auth Middleware

New middleware added before all API routes in both `electron/server.ts` and `server/api-plugin.ts`:

- **Local requests skip auth** — check `req.socket.remoteAddress` for `127.0.0.1`, `::1`, `::ffff:127.0.0.1`
- **Remote requests require a token** — checked in this order:
  1. `Authorization: Bearer <token>` header
  2. `?token=<token>` query parameter (needed for EventSource/SSE which can't set headers)
- **Token comparison** — constant-time comparison of the token against `networkPassword` from config
- **Unauthenticated remote requests** — return 401 JSON for `/api/*` routes; the frontend handles showing a login screen

WebSocket upgrade requests (`/__pty`) also check the token via query param on the upgrade URL.

### 3. Frontend Auth Layer

A new `useNetworkAuth` hook:

- Detects if the current page is loaded from a remote host (not `localhost` / `127.0.0.1`)
- If remote, reads token from `localStorage` key `cogpit-network-token`
- Provides a global `authFetch` wrapper that injects the `Authorization` header
- Provides `authEventSourceUrl(url)` that appends `?token=...` for SSE
- If a request returns 401, clears the stored token and shows a login screen
- Login screen: simple password input that validates against `/api/auth/verify`, stores on success

All existing `fetch()` calls and `new EventSource()` calls in hooks will be updated to use the auth-aware variants.

### 4. Server Binding

**Electron (`electron/main.ts`):**
- After `loadConfig()`, read `networkAccess` and `networkPassword`
- If both are set and truthy: bind to `0.0.0.0:19384`
- Otherwise: bind to `127.0.0.1:0` (current behavior)
- Expose an IPC-free restart mechanism: close the HTTP server and recreate it with new bind params when config changes

**Vite dev (`vite.config.ts`):**
- Read `config.local.json` at startup to check `networkAccess`
- If enabled, set `server.host: '0.0.0.0'` in Vite config

### 5. Network Info Endpoint

New route `GET /api/network-info`:

```json
{
  "enabled": true,
  "host": "192.168.1.50",
  "port": 19384,
  "url": "http://192.168.1.50:19384"
}
```

Uses `os.networkInterfaces()` to find the first non-internal IPv4 address. Returns `{ enabled: false }` when network access is off.

### 6. Connection URL in Header

**DesktopHeader changes:**
- New prop `networkUrl: string | null`
- When non-null, render a clickable URL chip between the session info and the toolbar buttons
- Click copies the URL to clipboard with a brief "Copied!" feedback
- Styled subtly (zinc-500 text, monospace) to not dominate the header

**App.tsx changes:**
- Fetch `/api/network-info` on mount and when config changes
- Pass `networkUrl` to `DesktopHeader` and `MobileHeader`

### 7. Settings UI (ConfigDialog)

Add a "Network Access" section below the existing claude dir config:

- **Toggle switch** — enables/disables network access
- **Password input** — shown when toggle is on, with show/hide toggle
- **Status indicator** — "Active" / "Inactive" based on current server state
- **Note** — "Restart required" message when settings differ from running state, with a "Restart Server" button in Electron mode

### 8. Security Considerations

- Local clients always bypass auth (no password needed when using the app normally)
- Password stored in plaintext in `config.local.json` (same security model as other local config)
- Constant-time token comparison to prevent timing attacks
- No HTTPS by default (LAN-only use case) — users can put a reverse proxy in front if needed
- PTY/shell access is the highest-risk surface; gated behind the same auth as everything else

## Files Changed

| File | Change |
|------|--------|
| `server/config.ts` | Extend `AppConfig` type, pass new fields through load/save |
| `server/helpers.ts` | Add `authMiddleware` function |
| `server/routes/config.ts` | Handle new fields in GET/POST `/api/config`, add `/api/network-info` and `/api/auth/verify` |
| `electron/server.ts` | Add auth middleware, support dynamic server restart |
| `electron/main.ts` | Conditional bind address based on config |
| `server/api-plugin.ts` | Add auth middleware for Vite dev mode |
| `server/pty-plugin.ts` | Add token check on WebSocket upgrade |
| `src/hooks/useNetworkAuth.ts` | New hook: auth state, token storage, authFetch, login gate |
| `src/hooks/useAppConfig.ts` | Fetch network info, expose `networkUrl` |
| `src/components/DesktopHeader.tsx` | Show connection URL chip |
| `src/components/MobileHeader.tsx` | Show connection URL chip |
| `src/components/ConfigDialog.tsx` | Add network access toggle + password field |
| `src/components/LoginScreen.tsx` | New component: password entry for remote clients |
| `src/App.tsx` | Integrate auth gate and network URL |
| All hooks using `fetch`/`EventSource` | Use auth-aware wrappers |
