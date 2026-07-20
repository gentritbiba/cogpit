# Multi-Device Hub — Implementation Plan (2026-07-20)

One Cogpit instance (the **hub**) can register multiple remote devices (Electron app with
network access, or headless `cogpit-server`) and control ONE active device at a time via a
dropdown switcher + keyboard shortcuts. No merged views. The browser never leaves the hub
origin: the hub reverse-proxies device traffic under `/hub/:deviceId/*`.

Design provenance: 6-reader codebase audit + 3-designer judge panel. Verified constraints in
`/private/tmp/claude-501/-Users-gentritbiba-agent-window/1bbacd17-9b5c-4013-a3e0-7edfd4778795/scratchpad/constraints-digest.md`.

## Non-negotiable security invariants (pin with tests BEFORE/WITH proxy wiring)

1. `isPublicPath` (server/security.ts) must treat `/hub/` as protected exactly like `/api/`,
   and add `/api/hello` to PUBLIC_PATHS. Without this the proxy is an unauthenticated remote
   shell for the whole fleet (SPA fallback masks the mistake with 200 HTML).
2. Proxy resolves devices by opaque registry id only — never a host from the URL (SSRF).
   Registration rejects loopback/link-local hosts unless `allowLocalTunnel: true`
   (ssh-tunnel pattern; those devices register `auth: "none"` and are badged unauthenticated).
3. A device-side 401 must NEVER reach the browser as a 401 (it would nuke the hub token and
   flip the app to LoginScreen, incl. blind EventSource). Proxy maps device auth failures to
   `502 {code: "DEVICE_AUTH_FAILED"}` after one single-flight re-mint + replay.
4. Token minting against a device is single-flight per device with ≥5s spacing (device rate
   limit is 5/min/IP; a device restart fires 4 SSE reconnects + parallel fetches at once).
5. Env-derived headless credentials (COGPIT_NETWORK_PASSWORD) live in memory only; POST
   /api/config must never persist them.
6. `buildPermissionArgs` (src/lib/permissions.ts) missing-mode → bypass footgun is fixed
   (missing mode → `--permission-mode default`), and per-device permission scopes default to
   explicit `DEFAULT_PERMISSIONS`.
7. Unprefixed `/api/*` on any machine keeps meaning "this machine" (external-agent contract,
   cogpit-sessions skill). Unprefixed UI URLs keep meaning local device.
8. State-changing (non-GET/HEAD) `/hub/*` requests require header `X-Cogpit-Client: 1`
   (drive-by localhost CSRF guard). `authFetch` always sends it.

## Server

### New: `server/routes/hello.ts` — ✅ DONE (routes agent)
`registerHelloRoutes(use, opts: { mode: "electron" | "standalone" | "dev" })`.
GET `/api/hello` → `{ app: "cogpit", version, hubApi: 1, mode, name, instanceId,
networkAccess, configured }`.
- `version`: package.json read at module init (try/catch → "unknown").
- `name`: `process.env.COGPIT_DEVICE_NAME || os.hostname()`.
- `instanceId`: module-level `randomBytes(8).toString("hex")` per boot (self-add rejection).
- No filesystem paths in payload. Public (PUBLIC_PATHS) + exempt from the 503
  NOT_CONFIGURED guard in BOTH shells (add next to `/api/config`, `/api/notify`).

### New: `server/hub/registry.ts`
Persists `devices.local.json` (mode 0600, chmod after every write) in the same dir as
config.local.json: `initDeviceRegistry(dir)` called by electron/server.ts (userDataDir) and
api-plugin (project root).
```ts
interface HubDevice { id: string /* "dev_"+8-byte hex */; name: string; host: string;
  port: number /* default 19384 */; auth: "password" | "none"; password?: string;
  addedAt: number }
interface DeviceRuntime { authState: "ok" | "bad-password" | "unknown"; lastProbe?: number;
  lastHello?: unknown }
```
Exports: `initDeviceRegistry(dir)`, `getDevice(id)`, `listDevices()` (never serializes
password; includes runtime), `addDevice`, `updateDevice`, `removeDevice`,
`validateDeviceHost(host, allowLocalTunnel): string | null` (reject 127/8, ::1, localhost,
169.254/16, 0.0.0.0 unless allowLocalTunnel), `setDeviceRuntime(id, patch)`.

### New: `server/hub/device-client.ts`
Per-device token lifecycle (in-memory Map deviceId → {token, mintedAt}).
- `getDeviceToken(device)`: null for auth:"none"; cached if age < 20h; else mint via
  POST `http://host:port/api/auth/verify` with `Authorization: Bearer <password>`, 5s
  timeout. Single-flight per device (share inflight promise) + ≥5000ms between mint
  attempts per device (on cooldown → throw last error).
- Mint 401/invalid → set authState "bad-password", throw `DeviceAuthError`. Network
  error/timeout → `DeviceUnreachableError`.
- `invalidateDeviceToken(id)`.

### New: `server/hub/proxy.ts`
`createHubProxyHandler()` mounted via `use("/hub", handler)` in BOTH shells (both strip the
mount prefix; req.url is `/:deviceId/rest`).
- Parse deviceId; unknown → JSON `404 {code:"UNKNOWN_DEVICE"}`. Rest must start `/api/`
  else JSON `404 {code:"BAD_HUB_PATH"}` (also blocks /hub/x/hub/y recursion). Never fall
  through to SPA.
- Non-GET/HEAD without `X-Cogpit-Client: 1` → `403 {code:"MISSING_CLIENT_HEADER"}`.
- Buffer request body fully (bodySizeLimit already caps 5MB) so it can be replayed once.
- Outbound `http.request` to device: path = rest with hub `token` query param REMOVED;
  headers copied minus `authorization`, `host`, `connection`, `upgrade`, `keep-alive`,
  `accept-encoding`; plus `Authorization: Bearer <deviceToken>` when auth==="password".
- No idle timeout (send-message holds minutes). Connect watchdog ~7s → `502
  {code:"DEVICE_UNREACHABLE"}`; same for ECONNREFUSED/EHOSTUNREACH/etc.
- Device 401 → invalidateDeviceToken, getDeviceToken again (single re-mint), replay
  buffered request once; second 401 → `502 {code:"DEVICE_AUTH_FAILED"}`. All other
  statuses (incl. 403/503) pass through verbatim.
- Response: stamp `X-Cogpit-Device: <id>`, `writeHead(status, headers-minus-hop-by-hop)`,
  `proxyRes.pipe(res)` raw (no buffering — SSE flushes through). On close of either side
  destroy both. No compression anywhere in the chain.
- `handleHubUpgrade(req, socket, head): boolean` for `/hub/:deviceId/__pty`:
  hub-side auth first (same as existing /__pty branch: local OR networkAccess+valid
  ?token=), resolve device, mint token, open upgrade request to device
  `/__pty?token=<deviceToken>` (device reads only query on upgrade), splice sockets on
  'upgrade' (pattern: electron/server.ts dev-HMR proxy), TCP keepalive 30s both sides,
  one re-mint retry on 401 upgrade response; failure → write `HTTP/1.1 502` and destroy.
  Wire in electron/server.ts upgrade handler AND server/pty-plugin.ts.

### New: `server/routes/devices.ts` — ✅ DONE (routes agent; single connect mount, 30 tests)
(hub management; under /api/hub/* so existing auth+503
guard apply)
- GET `/api/hub/devices` → `{ devices: [...] }` (with runtime status; no passwords).
- POST `/api/hub/devices/probe` `{host, port}` → GET device `/api/hello` (3s timeout):
  `{ok:true, hello}` | `{ok:false, code}` where code ∈ UNREACHABLE, NOT_COGPIT (non-JSON
  non-HTML), LEGACY_NO_HELLO (200 text/html SPA-fallback signature → "update that device"),
  SELF_ADD (hello.instanceId === own instanceId).
- POST `/api/hub/devices` `{name?, host, port?, password?, allowLocalTunnel?}` → validate
  host, probe, then if password: verify against device /api/auth/verify surfacing
  BAD_PASSWORD / NETWORK_DISABLED (403) / NOT_CONFIGURED (503) / UNREACHABLE distinctly;
  no password → auth:"none" (only with allowLocalTunnel). Save; return `{device}`.
- PATCH `/api/hub/devices/:id` (rename/host/password → invalidate token, re-probe),
  DELETE `/api/hub/devices/:id`, POST `/api/hub/devices/:id/test` → re-probe + auth check.

### security.ts changes
`isPublicPath`: protected = startsWith `/api/` OR `/__pty` OR `/hub/`; PUBLIC_PATHS +=
`/api/hello`. Tests: remote `/hub/x/api/y` and `/hub/x/__pty` without token → 401; `/api/hello`
without token → 200 path (public).

### Registration (BOTH `electron/server.ts` AND `server/api-plugin.ts` — project rule)
initDeviceRegistry, registerHelloRoutes (+503-guard exemption), registerDeviceRoutes, hub
proxy mount, upgrade branch (electron/server.ts + server/pty-plugin.ts). Integration test
per shell: unmatched `/hub/...` returns JSON 404, never SPA HTML.

### Headless bootstrap (`server/standalone.ts` + `server/config.ts`) — ✅ DONE (2026-07-20)
Env-override merge + `stripEnvOverride` live in config.ts; pure helpers in
`server/lib/standalone-bootstrap.ts` (unit-tested). Tests: config.test.ts (+env override,
chmod), standalone-bootstrap.test.ts.
- Env overrides IN MEMORY ONLY: `COGPIT_NETWORK_PASSWORD` / `COGPIT_NETWORK_PASSWORD_FILE`
  (file wins; trims trailing newline; plays with systemd LoadCredential). Applied as a
  separate module-level override consulted by `getConfig()` merge — `saveConfig`/POST
  /api/config can never persist them (test: set env, POST config, read file → no password).
  Enforce `validatePasswordStrength` → `exit(1)` with message.
- Fail closed: binding non-loopback COGPIT_HOST without any network password (env or
  config) → `exit(1)` with instructions (never bind an unauthenticated shell).
- First-run synthesis: no config file + `~/.claude/projects` exists → save
  `{claudeDir: ~/.claude}` (keep detectCodexOnlyConfig fallback).
- Boot banner: print name, LAN host:port, "Add this device in Cogpit → Devices".
- `COGPIT_DEVICE_NAME` respected (hello route reads env directly).
- One-liner story: `COGPIT_HOST=0.0.0.0 COGPIT_NETWORK_PASSWORD=... bun server/standalone.ts`

## Client

### New: `src/lib/device.ts`
```ts
export const LOCAL_DEVICE_ID = "local"
export function getActiveDeviceId(): string      // from location.pathname "/d/:id/..." else "local"
export function isRemoteDeviceActive(): boolean
export function devicePrefix(): string           // "" local, "/hub/<id>" remote (SERVER proxy prefix)
export function withBase(url: string): string    // prefix /api/* and /__pty with devicePrefix();
                                                 // NEVER prefix /api/hub/* or /api/auth/*
export function deviceScopedKey(base: string): string // base local; `${base}::${id}` remote
export function switchDevice(id: string): void   // pushState to saved-last-path or "/d/<id>/",
                                                 // dispatch window event "cogpit-device-changed"
```
Last-path memory: sessionStorage `cogpit-last-path::<deviceId>` written by useUrlSync.

### Choke points (signatures unchanged — authFetch has 102 direct callers, CRITICAL)
- `src/lib/auth.ts`: authFetch — when input is a string starting "/api", apply `withBase`;
  always set `X-Cogpit-Client: 1`; rest identical (401 semantics untouched → hub-only).
  Also: on `res.status === 502 && res.headers.get("X-Cogpit-Device")` dispatch
  `cogpit-device-unreachable` (banner signal), still return res. authUrl — apply withBase
  before token append. New `hubFetch(url, init)` = authFetch WITHOUT device prefixing, for
  hub-scoped call sites (useDevices, NetworkStatus /api/network-info).
- `src/hooks/usePtySocket.ts` buildWsUrl: `${proto}//${host}${devicePrefix()}/__pty?...`.
  Socket reconnects on device switch via App remount (key) — no extra logic.
- `src/components/timeline/markdown-components.tsx`: img src via `authUrl(...)` (fixes
  pre-existing token-less remote <img> bug AND adds device prefix).
- `src/components/PreviewPanel.tsx` urlForPort: active device's registry host when remote
  (from useDevices), else window.location.hostname.

### Device switch = keyed remount
`src/main.tsx`: wrap `<App/>` in new `DeviceRoot` (src/components/DeviceRoot.tsx): owns
`activeDeviceId` state (init from URL), listens `cogpit-device-changed` + `popstate`,
renders `<App key={activeDeviceId}/>`. All App hook state resets on switch; module caches
get device-scoped keys instead:
- `src/lib/sessionCache.ts` makeKey + `src/lib/sessionPrefetch.ts` inflight: prefix
  `${getActiveDeviceId()}:` (warm switch-back for free).
- `src/hooks/useSessionHistory.ts` storage key via deviceScopedKey.
- `src/lib/permissions.ts` / usePermissions: storage key via deviceScopedKey; absent →
  explicit DEFAULT_PERMISSIONS; fix buildPermissionArgs missing-mode → default (+ test).
- Cosmetic dirName-keyed localStorage (custom names, collapsed state, mcpSelection) —
  defer, harmless.

### URL scheme (`src/hooks/useUrlSync.ts`)
`/d/:deviceId` prefix consumed/emitted around the existing scheme ("d" cannot collide:
claude dirNames start "-", codex "codex__"). Unprefixed = local, all bookmarks keep
working. New tab on "/" is ALWAYS local (no localStorage seeding). Reload lands on same
device (SPA fallback serves /d/* fine). Deep link to /d/<id>/<dirName>/<session> restores
device context. Write last-path sessionStorage on every path change.

### UI
- `src/components/DeviceSwitcher.tsx`: dropdown in DesktopHeader (near NetworkStatus) +
  mobile header slot. Lists "This Mac" (localhost = Electron/hub machine) + devices with
  status dot (probe fired on dropdown-open only — no background polling), version hint on
  skew, active check. Click → switchDevice. Footer: "Add device…", "Manage devices…".
- `src/components/DevicesDialog.tsx`: list (status, rename, remove, re-test) + add form:
  host[:port] + password, live typed probe errors (UNREACHABLE / NETWORK_DISABLED /
  NOT_CONFIGURED / BAD_PASSWORD / LEGACY_NO_HELLO / SELF_ADD / NOT_COGPIT), tunnel
  escape-hatch checkbox ("This is a local tunnel — no password", warning badge). On
  success: auto-switch + toast teaching the shortcut.
- Offline banner (in App or DeviceRoot): shows when active remote device unreachable
  (cogpit-device-unreachable event); retry button + auto-retry 10s while visible; "Switch
  to This Mac" escape.
- Action gating when remote: HIDE open-in-editor / open-terminal / reveal-in-finder
  (they'd open windows on the remote machine); offer copy-path. Hide network-access
  section of ConfigDialog (prevents rotating a remote password → hub lockout). Chip
  "on <device>" in ChatInput and terminal/scripts surfaces.
- Shortcuts via existing keybindings registry (src/lib/keybindings.ts): `mod+shift+1..9`
  jump to Nth device (1 = local, then registry order), `mod+shift+0` cycle. Command
  palette: "Switch to <device>" actions. (mod+1..9 is browser-reserved — vetoed.)
- Remote device UX passthroughs that Just Work via proxy: unconfigured device renders its
  own SetupScreen; PTY terminals/ScriptsDock run on the device (chip makes it obvious).

> **UI status (2026-07-20):** DONE — `useDevices` hook (on-demand refresh, no polling;
> re-syncs all consumers via a `cogpit-devices-changed` event), `DeviceSwitcher` (header
> dropdown, probes-on-open, version-skew hint, "This machine" default), `DevicesDialog`
> (live typed probe copy, add form, tunnel escape-hatch + warning, rename/remove/re-test,
> shortcut tip), `DesktopHeader` integration (renders `<DeviceSwitcher/>` beside
> NetworkStatus), `PreviewPanel` `urlForPort(port, host)` uses the active device host, and
> keybindings registry entries `device.switch.1..9` + `device.cycle` (mod+shift). Gates
> green (lint, tsc, 2199 tests). Deferred to the orchestrator: App-level keydown wiring for
> the device shortcuts (registry-only per scope) — ready-made matchers
> `matchDeviceSwitchIndex(event)` / `matchDeviceCycle(event)` are exported from
> `keybindings.ts`. Offline banner + action-gating (open-in-editor/terminal, ConfigDialog
> network section) NOT in this slice — owned elsewhere / follow-up.

## Adjacent fixes (verified real, same change)
- LoginScreen.tsx: `setToken(data.token || password)` → only `setToken(data.token)` when
  present (stops persisting raw password for local logins).
- server/config.ts saveConfig: chmod 0600 config.local.json. ✅ DONE (2026-07-20)
- buildPermissionArgs missing-mode footgun (above).

## Deferred (explicitly)
TLS, QR/mDNS discovery, AES credential vault (0600 plaintext + honest docs; hub is tier-0),
global SSE-401 re-auth detector, remote notifications, merged multi-device views
(permanently, per user mandate), cosmetic localStorage scoping, X-Forwarded-For trust.

## Testing
`bun run test` green; new suites: security pins (/hub protected, /api/hello public, JSON
404 both shells), registry (validation, 0600, no password serialization), device-client
(single-flight, spacing, cooldown), proxy (typed 502s, token strip/replace, replay-once,
SSE passthrough, X-Cogpit-Client), standalone bootstrap (env in-memory only, fail-closed),
device.ts (withBase rules, scoped keys), auth.ts (prefixing + unchanged local semantics),
useUrlSync (/d/ parse/emit), permissions (missing mode → default).
