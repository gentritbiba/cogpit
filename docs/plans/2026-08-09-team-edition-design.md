# Team Edition & Plugin Platform — Design (2026-08-09)

Cogpit grows a second **edition**: a multi-user, business-ready deployment of
`cogpit-server` for a team doing agentic work on a shared remote machine, with
authentication, roles, workspaces, sharing, full-fidelity audit, per-member
usage attribution, and a compile-time plugin system so forks can specialize
(e.g. an SEO-flow suite) without diverging from upstream.

Personal Cogpit is untouched. One codebase, one binary, two editions.

## Decisions (validated 2026-08-09)

| Topic | Decision |
|---|---|
| Workload | Agency/MCP workflows + general agentic ops |
| Identity | Local accounts, admin-created (no SSO in v1) |
| Visibility | Role-based: admins see all; members see own + shared (+ opt-in workspace transparency) |
| CLI login | One shared Claude/Codex login on the server; ownership is Cogpit metadata |
| Workspaces | Admin-curated project dirs assigned to users |
| Admin-only | PTY terminal, server/MCP config (members keep all permission modes) |
| Sharing v1 | Named grants (view/interact), interactive handoff, view-only "links" |
| Plugins v1 | Compile-time fork model: custom views, launchable flows, timeline renderers |
| Audit | Full fidelity — verbatim message text in the trail |
| Monitoring | Logs + API first; dashboard UI later |
| Deployment | Linux VM, `cogpit-server` behind TLS proxy/tunnel |

## Non-goals and honest limitations

- **Not a hard multi-tenant security boundary.** All agents run as one OS user.
  Workspace scoping and role gates are *workflow* boundaries; a member can ask
  the agent itself to read anything the OS user can read. The real wall is at
  the OS level (see Ops). Hard per-user isolation (one server process or
  container per user, hub-multiplexed) is the designed-for future path, not v1.
- No SSO/OAuth, no runtime-loadable plugins, no usage dashboard UI in v1.
- Team edition is `cogpit-server` only. It refuses to start under Electron/dev.

## Rejected alternatives

- **Auth/audit gateway in front of an unmodified server** — role-based
  visibility requires filtering project/session lists and attributing messages;
  a proxy would have to parse and rewrite every response and SSE stream.
  Semantics live in the server, so identity must too.
- **One server process per user** — fights the shared-workspace, shared-pool,
  interactive-handoff model. Remains the escalation path for hard isolation.

---

## 1. Editions and feature flags

- `edition: "personal" | "team"`. Activated by `COGPIT_EDITION=team` env or
  `edition` in `config.local.json`; env wins (same in-memory override machinery
  as `COGPIT_NETWORK_PASSWORD` in `server/config.ts`). Not named "mode" — that
  word is taken (provider mode, hub mode).
- A small `features` config block for per-deployment dials, defaults derived
  from edition (e.g. `terminal: "admin" | "all" | "off"`).
- **The renderer never checks the edition.** The server computes a per-user
  `capabilities` object served by `GET /api/me`; personal edition returns
  all-capabilities for the implicit local user. UI gates inline off
  capabilities, mirroring the `isRemoteDeviceActive()` precedent.
- Capabilities (v1): `terminal`, `configWrite`, `manageUsers`,
  `manageWorkspaces`, `manageDevices`, `killAny`, `viewAllSessions`,
  `share`, `runFlows`, plus `role` and `user` identity fields.
- The NOT_CONFIGURED 503 gate keeps working: team edition still has exactly one
  `claudeDir` (one OS user), so `getConfig()` invariants hold.

## 2. Identity and authentication

**Trust model change (the big one): in team edition, "local = trusted" is
off.** `isTrustedDirectLocalRequest` (`server/security.ts`) short-circuits to
false for `/api` and `/__pty`. Exceptions, exhaustively:

- `/api/hello` — public handshake; gains `edition` field.
- `/api/notify` — localhost-only agent-hook sink (Claude/Codex Stop hooks on
  the same box must keep working).

Components:

- **Users** — `<dataDir>/team/users.json`, 0600 via `atomicJsonFile`:
  `{id, username, displayName, role: "admin" | "member", passwordHash,
  createdAt, disabled?}`. Hashing reuses versioned scrypt
  (`server/password-utils.ts`). No database at agency scale.
- **Login** — `POST /api/auth/verify` learns a second shape: JSON
  `{username, password}` for browsers, `Authorization: Bearer user:pass` for
  machine clients (the hub uses this). Personal bare-password flow unchanged.
- **Principal seam** — the in-memory token map `SessionInfo`
  (`server/security.ts`) gains `principal: {userId, role}`. Every request's
  principal is resolvable via a `getPrincipal(req)` helper.
- **Persisted sessions** — `team/sessions.json` mirrors token **hashes** →
  `{userId, createdAt, expiresAt}` so a restart doesn't log the company out.
  Idle tracking stays in memory (restart resets idle timer; absolute 8 h expiry
  persists). Disabling a user or changing their password revokes their tokens.
- **Bootstrap** — edition=team with zero users serves a one-time
  create-first-admin screen (SetupScreen pattern) backed by
  `POST /api/team/bootstrap`, race-safe, permanently closed after user #1.
- **HTTP status contract** — 401 = missing/expired session (client flips to
  login via existing `cogpit-auth-required`); **403 = authenticated but
  forbidden** (client shows "no access" and must NOT clear the session). All
  new authz denials are 403s.

## 3. Hub compatibility (personal app ↔ team server)

A team server stays addable as a device from personal Cogpit:

- `/api/hello` advertises `edition`; the add-device form shows a username field
  when present.
- `HubDevice` gains `auth: "user"` with `{username, password}`; the hub's
  `device-client` mints device tokens via `Bearer user:pass`. Same single-flight
  minting, same 401→re-mint→`502 DEVICE_AUTH_FAILED` machinery, zero protocol
  changes.
- Everything done through the hub is attributed and filtered as that user: an
  admin's desktop app sees everything; a member's sees their slice.

## 4. Authorization

Two layers, both centralized:

**Route policy table** — `server/team/policy.ts`. Every route id in
`API_ROUTE_REGISTRY` must have an entry: default requirement
(`member` | `admin`) plus per-path/method overrides (e.g. `config` GET member,
POST admin). Evaluated by an authz middleware immediately after
`authMiddleware`. Safety nets:

- The route-parity test (`server/__tests__/api-routes.test.ts` precedent)
  extends to fail CI when a route id lacks a policy entry.
- Unlisted `/api` paths **default-deny** in team edition.

Admin-only set (v1): PTY (`/__pty` upgrade + pty surfaces), `config` POST,
`config-browser` mutations, `devices`, `system-processes` +
`kill-port`/`kill-process`/`kill-all`, `editor` routes. Everything else is
member-reachable, subject to resource access below.

**Resource access helpers** — `server/team/access.ts`:

- `assertSessionAccess(principal, sessionId, "view" | "interact" | "own")`
- `assertWorkspacePath(principal, absPath)`
- `listVisibleSessions(principal)` / `filterVisibleProjects(principal, ...)`

Dropped as one-line guards into session-touching route modules. **Aggregate
endpoints are first-class enforcement points** — `projects`, `active-sessions`,
`find-session`, `mission-control`, `permissions` (pending prompts), `ask-user`
(pending questions), `workflows`, `teams`/`team-session` (visibility follows
the lead session), `session-file-changes`, `files-watch` SSE (checked at
connect; revocation applies to new connects), `session-config` (writes need
interact), `undo` (owner/admin), `session-context`.

Access levels: `view` = read transcript/state; `interact` = view + send
messages, answer permission prompts and questions, stop/interrupt; `own` =
interact + delete, branch, undo, share management (owner or admin).

## 5. Workspaces

`team/workspaces.json`: `{id, name, path, members: userId[] | "all",
sessionsVisibleToMembers: boolean (default false), createdAt}`.

For members, workspaces scope everything path-shaped:

- `/api/projects` lists only projects whose cwd is inside an assigned
  workspace; session creation validates cwd the same way.
- The arbitrary-path endpoints — `local-file`, `file-content`, `scripts?dir=`,
  `project-files`, `project-file`, `git-status`, `worktrees` — validate
  containment against assigned workspace roots via the existing symlink-safe
  `resolveCanonicalFileWithinRoot` (`server/sessionPaths.ts`).
- Admins are unrestricted.

`sessionsVisibleToMembers: true` opts a workspace into "war-room" transparency:
all its sessions are visible (view-level) to all its members.

## 6. Ownership, visibility, sharing

- **Ownership index** — `team/sessions.json`: `sessionId → {ownerId,
  workspaceId, provider, createdAt}`, written by create/branch paths
  (`sessionSpawner`, `sessionBranching`). Sessions created outside Cogpit are
  unowned → admin-only until assigned.
- **Member visibility** = own ∪ shared-to-me ∪ transparent-workspace sessions.
  Admin = all.
- **Shares** — `team/shares.json`: `{id, sessionId, grantedTo: userId[] |
  "all", mode: "view" | "interact", grantedBy, createdAt}`. One primitive
  covers all three flavors: named share (userIds), view-only link (grant to
  `"all"`, mode view — the "link" is the normal session URL; no secret URLs),
  interactive handoff (mode interact).
- **Attribution** — every send records the acting user in the audit log, so
  "who sent what" is answerable in multi-writer sessions. Timeline "sent by X"
  chips come later by correlating audit events with transcript messages.

## 7. Audit and usage

**Audit** — `<dataDir>/team/audit/YYYY-MM-DD.jsonl`, append-only, 0600, one
event per line:

```json
{"ts": 1754700000000, "actor": {"userId": "u_ab12", "username": "gent"},
 "action": "session.message", "target": {"sessionId": "…", "dirName": "…",
 "workspaceId": "…"}, "data": {"text": "<verbatim message>"}, "ip": "…"}
```

Event families: `auth.*` (login, login-failed, logout), `user.*`,
`workspace.*`, `share.*`, `session.*` (create, message, interrupt, stop,
delete, branch), `config.change`, `flow.run`. Writes serialize through one
append queue in `server/team/audit.ts`. Failure policy v1: loud health flag,
non-blocking (revisit fail-closed if accountability demands).

**Usage** — no new collection pipeline. Transcripts already carry tokens and
the pricing semantics live in `shared/session`; the ownership index joins
sessions→users. Computed on demand with a small cache.

**APIs**: `GET /api/team/audit` (admin; filter by user/action/date range),
`GET /api/team/usage` (admin: all members; member: self) → per-member tokens,
estimated cost, session/message counts. Dashboard UI is Phase 5.

## 8. Plugin architecture

Compile-time, fork-friendly:

- `plugins/<name>/` per plugin with a `plugin.ts` manifest;
  `plugins/index.ts` is the single registration point. **A fork touches only
  its plugin folder and that one line.**
- `src/plugin-api/` is the only sanctioned import surface into the app: typed
  extension points plus blessed utilities (`authFetch`, session helpers, UI
  kit re-exports). `scripts/check-architecture.ts` gains rules: `plugins/` may
  import only `shared/` + `src/plugin-api/`; `src/` imports plugins only via
  the registry loader.

```ts
// plugins/seo-suite/plugin.ts
import type { CogpitPlugin } from "@/plugin-api"
const plugin: CogpitPlugin = {
  id: "seo-suite",
  views: [{ id: "seo", title: "SEO", icon, component: SeoDashboard }],
  timelineRenderers: [{ match: (tool) => tool.startsWith("mcp__keywordtool"), component: KeywordTable }],
  flows: [keywordAuditFlow],
}
export default plugin
```

Extension points v1:

1. **Views** — nav entry + main view. `mainView` union extends with
   `plugin:<id>`; `resolveDesktopMainView` (pure, tested) dispatches.
   Optional `requiredCapability`.
2. **Timeline renderers** — consulted before built-in tool rendering.
3. **Flows** — declarative session recipes:
   `{id, name, description, provider?, model?, effort?, permissionMode?,
   mcpSelection?, workspaceId?, prompt (with {{variables}}),
   variables: [{name, label, type, options?}], form?: Component}`.
   Two sources feed one `GET /api/flows` registry: compile-time plugin flows
   and **admin-curated JSON flows** in `team/flows/*.json` (no code needed).
   Launch rides `create-and-send`; runs are audited as `flow.run`.

Dogfooding keeps the API honest: Mission Control converts to a registered
view; at least one built-in renderer moves onto the renderer registry. This
work forces the valuable slice of the `src/App.tsx` decomposition (gate
ladder → view switch → context assembly extraction; collapse
`desktopTypes.ts` prop-bundle sprawl where touched).

## 9. Renderer changes (exhaustive list)

- `LoginScreen`: username field when hello advertises team (~20 lines).
- `/api/me` → `AppContext`: `{user, role, capabilities}`; inline `can()` gates
  hide terminal, config editing, device management for members.
- Share menu on sessions; "Shared with you" group in the session browser;
  owner chip on shared sessions.
- `deviceScopedKey` → identity-scoped key (device + userId) in
  `src/lib/device.ts` — one function; all 8 call sites already route through
  it.
- Plugin-api surface + view/renderer/flow registration (Phase 4).

Everything else is capability-driven and byte-identical in personal edition.

## 10. Data layout

```
<dataDir>/
  config.local.json          # + edition, features
  devices.local.json         # + auth: "user" devices
  team/
    users.json               # accounts, scrypt hashes, roles
    sessions.json            # login-token hashes (restart survival)
    workspaces.json
    shares.json
    sessions-index.json      # sessionId → owner/workspace   (name TBD in impl)
    flows/*.json             # admin-curated flow recipes
    audit/YYYY-MM-DD.jsonl   # append-only, full fidelity
```

All 0600 via `atomicJsonFile` / owner-only appends. Back up `team/` + config.

## 11. Testing strategy

Repo standard applies (near 1:1 test culture; security invariants pinned):

- Policy parity: every route id has a policy entry (CI fails otherwise);
  unlisted paths default-deny in team edition.
- Trust: local unauthenticated request → 401 in team edition (except
  hello/notify); personal edition behavior byte-identical (regression pins).
- 401 vs 403 contract; member hitting admin route keeps their session.
- Containment: path endpoints reject outside-workspace paths (symlink cases).
- Visibility: aggregate endpoints (`projects`, `active-sessions`,
  `mission-control`, `permissions`, `ask-user`, `find-session`) leak nothing
  across members; SSE connect checks.
- Sharing: view cannot send; interact cannot delete; revocation.
- Hub: user-auth device add, token mint as principal, attribution through
  proxy.
- Audit: every mutating action emits exactly one event; message text verbatim.
- Plugins: architecture-check rules; view/renderer/flow registration units.
- Bootstrap: race-safety, closed after first admin.

## 12. Rollout phases

- **Phase 0 — groundwork (zero behavior change):** route policy metadata + CI
  parity test, App.tsx gate/view extraction, `plugin-api` skeleton,
  identity-scoped keys.
- **Phase 1 — team core (deployable single-admin):** edition flag, users
  store, login + persisted sessions, local-trust off, authz middleware,
  bootstrap screen, hub user-auth, `/api/me`.
- **Phase 2 — workspaces:** ownership index, visibility filtering, path
  scoping of blast-radius endpoints.
- **Phase 3 — sharing + audit + usage APIs.**
- **Phase 4 — plugins:** three extension points, dogfood conversions, flows
  launcher (JSON + plugin flows).
- **Phase 5 — admin UI:** users/workspaces panels, audit browser, usage
  dashboard, timeline attribution chips.

## 13. Ops runbook (summary; full version goes in docs/self-hosting.md)

- Linux VM; `cogpit-server` as a **dedicated OS user whose filesystem access
  is limited to the workspace tree + CLI dirs** — this is the actual security
  boundary given one shared agent login.
- `COGPIT_EDITION=team COGPIT_HOST=127.0.0.1` behind Caddy/nginx TLS or a
  Cloudflare tunnel (Secure-cookie requirement unchanged). systemd unit as in
  self-hosting doc + the edition env.
- Backups: `<dataDir>/team/`, `config.local.json`, and the CLIs' transcript
  dirs. Audit rotation is date-natural (daily files).

## Deferred (explicitly)

SSO/OAuth · runtime-loadable plugins · per-user OS isolation (containers/
processes) · usage dashboard & audit browser UI (Phase 5) · timeline
attribution chips · workspace-level roles · audit fail-closed switch ·
file-read audit events.
