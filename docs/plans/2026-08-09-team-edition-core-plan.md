# Team Edition Core — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or subagent-driven-development) to implement this plan task-by-task.

**Goal:** Ship the team-edition core from `docs/plans/2026-08-09-team-edition-design.md`: edition flag, user accounts, principal-carrying auth, restart-surviving login sessions, local-trust off, route policy + authz enforcement, first-admin bootstrap, hub user-auth, and the minimal renderer changes (username login, capabilities gating).

**Architecture:** One binary, two editions. `COGPIT_EDITION=team` (standalone shell only) flips the trust model: every request authenticates as a named user; a policy table over the canonical route registry enforces admin-only surfaces; capabilities flow to the renderer via `/api/me`. Personal edition stays byte-identical (every team check no-ops).

**Tech stack:** Bun + TypeScript, node:http middleware (connect contract), vitest, existing `atomicJsonFile`/`password-utils` primitives. No new dependencies.

**Rules for the executor:**
- TDD every task: failing test → minimal code → green → commit. Repo policy: never leave tests broken.
- Run `bun run test` (full) at every checkpoint marked ✋; otherwise run the named test files.
- Final gates before done: `bun run lint && bun run typecheck && bun run typecheck:tests && bun run check:architecture && bun run check:duplicates && bun run test && bun run build:web`.
- Commit after every task with a conventional message. Never add Co-Authored-By lines.
- All paths relative to the worktree root (`.worktrees/team-edition`).
- When a spec below conflicts with current file contents, adapt minimally and preserve the stated behavior contract; the tests are the contract.

---

### Task 1: Shared team contracts

**Files:**
- Create: `shared/contracts/team.ts`
- Test: `shared/__tests__/team-contracts.test.ts` (only if shared has a test dir pattern; otherwise skip test — types only)

```ts
// shared/contracts/team.ts — browser-safe (dependency rule 1: no runtime imports)
export type CogpitEdition = "personal" | "team"
export type TeamRole = "admin" | "member"

export interface TeamUserPublic {
  id: string
  username: string
  displayName: string
  role: TeamRole
  createdAt: number
  disabled?: boolean
}

export interface Capabilities {
  terminal: boolean
  configWrite: boolean
  manageUsers: boolean
  manageWorkspaces: boolean
  manageDevices: boolean
  killAny: boolean
  viewAllSessions: boolean
  share: boolean
  runFlows: boolean
}

export const ALL_CAPABILITIES: Capabilities = {
  terminal: true, configWrite: true, manageUsers: true, manageWorkspaces: true,
  manageDevices: true, killAny: true, viewAllSessions: true, share: true, runFlows: true,
}

export const MEMBER_CAPABILITIES: Capabilities = {
  terminal: false, configWrite: false, manageUsers: false, manageWorkspaces: false,
  manageDevices: false, killAny: false, viewAllSessions: false, share: true, runFlows: true,
}

export interface MeResponse {
  authenticated: boolean
  edition: CogpitEdition
  user: TeamUserPublic | null
  capabilities: Capabilities
}
```

Step: create file, `bun run typecheck`, commit `feat(team): add shared team contracts`.

---

### Task 2: Edition resolution (`server/team/edition.ts`)

**Files:**
- Create: `server/team/edition.ts`
- Test: `server/__tests__/team-edition.test.ts`

**Behavior contract:**
- `resolveEdition(env: NodeJS.ProcessEnv, configEdition: string | undefined, shell: "electron" | "standalone" | "dev"): CogpitEdition` — pure.
  - `env.COGPIT_EDITION === "team"` OR `configEdition === "team"` → candidate team; anything else → personal.
  - Team is only honored when `shell === "standalone"`; electron/dev force `"personal"` (return personal even when env says team).
- Module state: `initEdition(opts: { shell: "electron" | "standalone" | "dev"; configEdition?: string })` resolves once from `process.env` + args; `getEdition()`, `isTeamEdition()`; `__resetEditionForTest()`.
- Before `initEdition` is called, `getEdition()` returns `"personal"` (safe default — personal is the no-op path).

**Steps:**
1. Write failing tests: env team + standalone → team; env team + electron → personal; env team + dev → personal; config edition team + standalone → team; env `"TEAM"`/garbage → personal; uninitialized → personal; env wins over config when both set (env `"personal"` explicit + config team → personal — env, when set to a valid value, is authoritative).
2. `bun run test server/__tests__/team-edition.test.ts` → FAIL (module missing).
3. Implement (~40 lines).
4. Test green. Commit `feat(team): edition resolution with shell forcing`.

---

### Task 3: Config plumbing — `edition` field + `getDataRoot`

**Files:**
- Modify: `server/config.ts`
- Modify: `server/routes/config.ts` (POST field-rebuild — see design doc §"config field-by-field rebuild" constraint)
- Test: extend `server/__tests__/config.test.ts`

**Spec:**
- `AppConfig` gains `edition?: "team"`. `loadConfig` reads it (`parsed.edition === "team" ? "team" : undefined` in the `cachedConfig` assignment). `saveConfig` persists it because it's part of the object; **POST `/api/config` in `server/routes/config.ts` must carry it through**: in the final `saveConfig({...})` call add `edition: currentConfig?.edition` (admin sets it by editing the file/env, not via API — the API must merely not drop it).
- Add to `server/config.ts`:

```ts
export function getDataRoot(): string {
  return DATA_ROOT
}
```

**Steps:** failing tests (load round-trips edition; POST /api/config does not drop edition — follow the existing config.test.ts pattern for POST; getDataRoot returns setDataRoot value) → implement → green → commit `feat(team): persist edition in config and expose data root`.

**Status: DONE** (commit c81abd1). Deviation: the POST does-not-drop-edition test lives in `server/__tests__/routes/config-routes.test.ts` — that is where POST /api/config route tests actually live (config.test.ts only covers the module).

---

### Task 4: Users store (`server/team/users.ts`)

**Files:**
- Create: `server/team/users.ts`
- Test: `server/__tests__/team-users.test.ts`

**Behavior contract:**
- Storage: `<dataRoot>/team/users.json`, shape `{ users: TeamUser[] }`, written via `writeOwnerOnlyJson(path, data, 0o600)` (import from `../atomicJsonFile`), directory created with `{ recursive: true }` and `chmod 0o700` (skip chmod on win32 — copy the `process.platform !== "win32"` guard style from `server/config.ts`).
- `interface TeamUser extends TeamUserPublic { passwordHash: string }` (import public type from `shared/contracts/team`).
- `initUsersStore(dir: string): Promise<void>` — loads (missing file → empty), caches in module state. `__resetUsersForTest()`.
- `userCount(): number`; `listUsers(): TeamUserPublic[]` (**never** includes `passwordHash` — destructure it out, mirroring `server/hub/registry.ts` `listDevices`); `getUserByUsername(username)` / `getUserById(id)` → full record or null.
- `createUser({ username, displayName?, password, role }): Promise<TeamUserPublic>`:
  - normalize username `trim().toLowerCase()`; validate `/^[a-z0-9._-]{2,32}$/` and **no `:`** (colon is the Bearer separator); reject duplicates.
  - `validatePasswordStrength(password)` (import from `../security`) → throw on error.
  - `passwordHash: hashPassword(password)`; `id: "u_" + randomBytes(6).toString("hex")`.
- `setUserDisabled(id, disabled): Promise<void>`, `setUserPassword(id, password): Promise<void>` (strength-checked, re-hash), `setUserRole(id, role)` — must refuse to demote/disable the **last enabled admin** (throw `Error("Cannot remove the last admin")`).
- All mutations serialize through a single promise chain (persist-then-swap; copy the `commitDeviceMutation` pattern from `server/hub/registry.ts:116-137`).
- Typed errors: export `class UserValidationError extends Error` for all validation failures so routes map them to 400.

**Steps:** failing tests (create+list without hash; duplicate rejected; bad username rejected; colon rejected; weak password rejected; disable last admin rejected; persistence round-trip via re-init; file mode 0600 on POSIX) → implement → green ✋ full suite → commit `feat(team): user accounts store`.

**Status: DONE** (commit c433d20). Deviations: last-admin errors throw `UserValidationError("Cannot remove the last admin")` so Task 9 can map them to 400; a corrupt/unreadable users.json makes `initUsersStore` throw (fail closed) instead of starting empty, because an empty store would silently reopen the unauthenticated first-admin bootstrap (only ENOENT → empty).

---

### Task 5: Principal-carrying sessions + persistence

**Files:**
- Modify: `server/security.ts`
- Create: `server/team/sessionPersistence.ts`
- Create: `server/team/requestPrincipal.ts`
- Test: `server/__tests__/team-sessions.test.ts`, extend `server/__tests__/helpers.test.ts` only if signatures force it (keep signatures backward-compatible!)

**Spec — `server/security.ts`:**
- `SessionInfo` gains `principal?: SessionPrincipal` where:

```ts
export interface SessionPrincipal {
  userId: string
  username: string
  role: "admin" | "member"
}
```

- `createSessionToken(ip: string, userAgent?: string, principal?: SessionPrincipal): string` — third optional param; when present, store it on `SessionInfo` and (team edition only) call `persistSession(token, principal, createdAt)` fire-and-forget (`void persistSession(...).catch(() => {})`).
- New export `getSessionPrincipal(token: string): SessionPrincipal | null` — returns the principal of a **currently valid** session (reuse `validateSessionToken` internals without double-touching `lastActivity`: factor the expiry check into a private `getLiveSession(token)` used by both).
- `validateSessionToken` unchanged behavior, plus: on miss in team edition, consult `restoreSession(token)` from sessionPersistence — if it returns a principal + createdAt within absolute TTL and the user is still enabled (`getUserById`), rehydrate into `activeSessions` (fresh `lastActivity`, keep original `createdAt`) and return true. Import from `./team/sessionPersistence` and `./team/users`; guard the whole branch with `isTeamEdition()`.
- `revokeSessionToken` / `revokeAllSessions` also remove from persistence (team edition), fire-and-forget.
- New export `revokeSessionsForUser(userId: string): void` — removes matching in-memory sessions + persisted rows.

**Spec — `server/team/sessionPersistence.ts`:**
- File `<dataRoot>/team/sessions.json`: `{ sessions: Array<{ tokenHash: string; userId: string; createdAt: number; expiresAt: number }> }`, 0600.
- `tokenHash = createHash("sha256").update(token).digest("hex")` (token already has 256 bits entropy — sha256 is the right primitive, do NOT scrypt here).
- `initSessionPersistence(dir): Promise<void>` (prunes expired rows on load), `persistSession(token, principal, createdAt)`, `restoreSession(token): { userId: string; createdAt: number } | null`, `removeSession(token)`, `removeSessionsForUser(userId)`, `clearAllSessions()`, `__resetForTest()`. Mutations serialized like Task 4. `expiresAt = createdAt + 8h` (import/duplicate the constant — export `SESSION_ABSOLUTE_TTL_MS` from security.ts).
- restoreSession returns only userId+createdAt; the **current** role/username are re-read from the users store at rehydrate time (role changes apply on restart).

**Spec — `server/team/requestPrincipal.ts`:**

```ts
import type { IncomingMessage } from "node:http"
import type { SessionPrincipal } from "../security"

const principals = new WeakMap<IncomingMessage, SessionPrincipal>()
export function setRequestPrincipal(req: IncomingMessage, p: SessionPrincipal): void { principals.set(req, p) }
export function getRequestPrincipal(req: IncomingMessage): SessionPrincipal | null { return principals.get(req) ?? null }
```

**Steps:** failing tests (create-with-principal → getSessionPrincipal; restart survival: create → `__reset` in-memory map only → validate again → true with principal re-read; disabled user not restored; revokeSessionsForUser; absolute-TTL expiry honored on restore; personal edition: no team/sessions.json written) → implement → green ✋ → commit `feat(team): principal sessions with restart persistence`.

**Import-cycle guard:** `security.ts` → `team/sessionPersistence.ts` → must NOT import `security.ts` back (take TTL as an argument or a re-exported constant module `server/team/constants.ts` if needed). `bun run check:architecture` must stay green.

**Status: DONE.** Deviations, all cycle-guard or race driven:
- `validatePasswordStrength`/`MIN_PASSWORD_LENGTH` moved to `password-utils.ts` (security.ts re-exports both unchanged) — `team/users.ts` importing security.ts would have closed a cycle once security.ts imported `team/users.ts` for rehydrate.
- `SessionPrincipal` + `SESSION_ABSOLUTE_TTL_MS` live in `server/team/constants.ts` (the plan's constants-module option) and are re-exported from security.ts; `requestPrincipal.ts`/`sessionPersistence.ts` import the type from there, not from `../security` as sketched — the sketch would cycle at Task 6.
- sessionPersistence removals mutate the in-memory rows synchronously with only the file write queued: a queued removal let `validateSessionToken` rehydrate a just-revoked session from the still-present row (caught by the revokeSessionsForUser test).
- Added test hooks `__resetSessionsForTest` (security.ts, in-memory map only) and `__flushForTest` (sessionPersistence) for the restart simulation.
- Review follow-up (fix(team): propagate live session invalidations to persistence): every live-process invalidation — idle/absolute expiry in `getLiveSession`, UA-mismatch in `validateSessionToken`, the 60s sweeper, and explicit revocation — discards the persisted row too, via a private `discardSession` in security.ts. Persisted rows exist solely so sessions survive process death; a session invalidated while the process is alive stays invalid across restarts. Restart tests now also do a true disk round-trip (reset both modules' state, re-init from the file) plus a prune-on-load test.

---

### Task 6: Team-edition auth middleware behavior

**Files:**
- Modify: `server/security.ts` (`authMiddleware`, `websocketUpgradeRejection`, `PUBLIC_PATHS` handling)
- Test: `server/__tests__/team-auth-middleware.test.ts` (new; follow the request-mocking style of existing `helpers.test.ts`)

**Spec — `authMiddleware` team branch.** Current flow (see `server/security.ts:384-440`). Insert edition branch: when `isTeamEdition()`:

1. Untrusted-loopback 403 check stays (line 388-393 behavior).
2. **Skip the `isTrustedDirectLocalRequest` bypass** with two carve-outs, checked in order — both additionally require `hasTrustedMutationSource(req)` (a cross-origin browser source → 403 `Untrusted request source`, same as every other mutation screen; headerless curl/agent clients pass):
   - `path === "/api/notify"` AND `isTrustedDirectLocalRequest(req)` → `next()` (agent hooks).
   - `isBootstrapOpen()` (import from `./team/users`: `isUsersStoreInitialized() && userCount() === 0` — an uninitialized store keeps bootstrap closed, since `userCount()` is trivially 0 before `initUsersStore` runs) AND `path === "/api/team/bootstrap"` → `next()` (first-run; also add to nothing else).
3. Public paths (`/api/auth/verify`, `/api/hello`) → `next()` as today.
4. Do NOT require `config.networkAccess`/`networkPassword` in team edition (user credentials replace the network password entirely). Instead: token = bearer ?? cookie → `validateSessionToken` (same UA pinning rules) → miss → 401. Valid → `const p = getSessionPrincipal(token)`; if `!p` → 401 (legacy principal-less token). `setRequestPrincipal(req, p)`.
5. Mutation-source check (existing lines 431-437) applies unchanged.
6. Personal edition: **zero behavior change** — the whole branch is `if (isTeamEdition()) { ... } else { <existing code verbatim> }` or early-return structured equivalently.

**Spec — `websocketUpgradeRejection` team branch:** when `isTeamEdition()`: skip the trusted-local null return; require (browser: same-origin + valid cookie; machine: `?token=`) exactly as the remote path today but **without** the `config.networkAccess` gate; additionally resolve the principal and return `403` when `principal.role !== "admin"` (PTY is admin-only per design). Personal edition unchanged.

**Steps:**
1. Failing tests (init team edition in beforeEach, `__resetEditionForTest` in afterEach):
   - local unauthenticated GET `/api/projects` → 401 (the flagship invariant).
   - local `/api/notify` POST unforwarded-loopback → passes to next.
   - `/api/hello` → next (public).
   - `/api/team/bootstrap` with zero users → next; with ≥1 user → 401.
   - valid token with principal → next + `getRequestPrincipal(req)` returns it.
   - valid token without principal → 401.
   - team edition ignores `networkAccess:false` (still authenticates by token).
   - websocket: member token → 403; admin token → null; no token → 401.
   - personal edition regression pin: trusted local GET → next with no principal set.
2. FAIL → implement → green ✋ full suite (existing `helpers.test.ts` security tests must stay green untouched) → commit `feat(team): authenticate every request in team edition`.

**Status: DONE.** Deviations: `isBootstrapOpen()` realized as inline `isUsersStoreInitialized() && userCount() === 0` (both exported from users.ts, and Task 6's files list touches only security.ts); the team branches live in private `teamAuthMiddleware`/`teamWebsocketUpgradeRejection` entered by a one-line `isTeamEdition()` guard so the personal path stays byte-identical; a principal-less token on the websocket gets 403 via `getSessionPrincipal(token)?.role !== "admin"` (not an admin → no PTY). Review follow-up: both carve-outs now also require `hasTrustedMutationSource(req)` (closes cross-site notify spoofing and drive-by first-admin takeover) and bootstrap gates on `isUsersStoreInitialized()` (new export) so a boot-ordering regression cannot reopen it.

---

### Task 7: Route policy table + authz middleware

**Files:**
- Create: `server/team/policy.ts`, `server/team/authz.ts`
- Modify: `server/app-server.ts` (mount after `authMiddleware`), `server/api-plugin.ts` (mount for parity — it no-ops outside team edition)
- Test: `server/__tests__/team-policy.test.ts`, extend `server/__tests__/api-routes.test.ts`

**Spec — `server/team/policy.ts`:**

```ts
export type PolicyRequirement = "public" | "authed" | "admin"
export interface PolicyRule { prefix: string; methods?: string[]; requires: PolicyRequirement }
export const ROUTE_POLICIES: Record<string, PolicyRule[]> = { /* every registry id */ }
export function requirementFor(path: string, method: string): PolicyRequirement
```

- `ROUTE_POLICIES` has **one entry per id in `API_ROUTE_REGISTRY`** (`server/api-routes.ts:69-111`). The implementer must read each route module to enumerate its mounted prefixes. Requirements per the design doc:
  - `admin`: `devices` (`/api/hub/devices`), `editor` (all three paths), `performance` kill surface (`/api/system-processes` — both GET and `/kill`), `ports` kill (`/api/kill-port`; `/api/check-ports` + `/api/background-*` stay `authed`), `claude-manage` fleet ops (`/api/kill-all`, `/api/kill-process`; per-session ops stay `authed`), `config` POST (`{prefix:"/api/config", methods:["POST"], requires:"admin"}`; GET stays `authed`), `config-browser` mutations (non-GET methods on its prefixes; reads `authed`), `usage`.
  - `public`: `hello` (`/api/hello`).
  - Everything else: `authed` (including `hub`, `projects`, `claude`, `claude-new`, `notify`, `undo`, …).
- `requirementFor`: longest-prefix match wins; among equal prefixes a rule with `methods` beats one without when the method matches; **no match → `"admin"`** (fail-safe default for forgotten paths).

**Spec — `server/team/authz.ts`:**

```ts
export function teamAuthzMiddleware(req, res, next) {
  if (!isTeamEdition()) return next()
  const path = (req.url || "/").split("?")[0].toLowerCase()
  if (!path.startsWith("/api/") && !path.startsWith("/hub/")) return next()
  const requirement = requirementFor(path, (req.method || "GET").toUpperCase())
  if (requirement === "public") return next()
  const principal = getRequestPrincipal(req)
  if (!principal) return next() // authMiddleware already admitted it (notify/bootstrap carve-outs)
  if (requirement === "admin" && principal.role !== "admin") {
    return sendJson(res, 403, { error: "Admin access required", code: "FORBIDDEN" })
  }
  next()
}
```

(`/hub/*` requirement: `authed` — evaluate via a `hub` policy entry with prefix `/hub/`.)

- Mount in `server/app-server.ts` immediately after `authMiddleware` (find the `securityHeaders → bodySizeLimit → authMiddleware` sequence at ~line 52-54); same relative position in `server/api-plugin.ts`.

**Spec — parity test extension:** in `server/__tests__/api-routes.test.ts`, add: every id in `API_ROUTE_REGISTRY` has a `ROUTE_POLICIES` entry, and every `ROUTE_POLICIES` key exists in the registry (both directions — dead policy entries fail too).

**Steps:** failing tests (parity both directions; member GET `/api/projects` → next; member POST `/api/config` → 403; admin POST `/api/config` → next; member GET `/api/config` → next; member `/api/kill-all` → 403; member `/api/stop-session` → next; unknown `/api/never-registered` → admin-only; personal edition → middleware no-ops even for garbage paths) → implement → green ✋ → commit `feat(team): route policy table and authz enforcement`.

**Status: DONE.** Deviations: none material. Notes: performance's bare `use("/api", requestMonitor)` metrics tap is deliberately absent from `ROUTE_POLICIES` (listing `/api` would defeat the fail-safe default); config's auxiliary mounts (`/api/network-info`, `/api/auth/*`, `/api/connected-devices`, `/api/config/validate`) enumerated as `authed`; `config-browser` encoded as one shared-prefix pair (`GET` → authed, method-agnostic → admin) covering all four of its mounts; `/api/running-processes` (claude-manage read-only inventory) → `authed`.

Post-review hardening (policy review follow-up): (1) GET `/api/performance` no longer embeds the system-wide process snapshot for non-admins — in team edition `snapshot.system` (same data as admin-only `/api/system-processes`) is attached only when the request principal is admin, gated in the route handler itself since the rest of the snapshot stays member-visible; personal edition unchanged, and the member perf panel degrades gracefully (`system` is already optional — the Agent processes card just hides). (2) `requirementFor` prefixes now match only at path-segment boundaries (path equals the prefix, prefix ends in `/`, or next char is `/`), so `/api/hellox` no longer rides the `/api/hello` public rule — unmatched paths fall to the admin default. (3) `config` re-encoded to the conservative `config-browser` shape: exact `/api/config` prefix is `GET` → authed, method-agnostic → admin, so unknown future methods (PUT/DELETE) default to admin instead of authed; auxiliary mounts keep their own authed rules, and member POST `/api/auth/logout` stays reachable (pinned by test).

---

### Task 8: Team login on `/api/auth/verify`

**Files:**
- Modify: `server/routes/config.ts` (the `/api/auth/verify` handler, lines ~74-171)
- Test: `server/__tests__/team-login.test.ts`

**Spec:** inside the handler, after the `hasTrustedMutationSource` / `canIssueBrowserSession` / `isRateLimited` checks (which all still apply), branch on `isTeamEdition()`:

- **No trusted-local short-circuit in team edition** — move the existing `isTrustedDirectLocalRequest` early-return under `if (!isTeamEdition())`.
- Credential extraction:
  - `Authorization: Bearer <value>`: if value contains `:`, split at the **first** colon → `{username, password}`; no colon → 401 `{ valid:false, error:"Username required" }`.
  - Else read JSON body via `readJsonBody` (import from `../http`) → `{ username, password }` strings.
- Normalize username (`trim().toLowerCase()`), look up via `getUserByUsername`. Unknown user → run `verifyPasswordAsync(password, DUMMY_HASH)` anyway (timing parity; create `DUMMY_HASH = hashPassword("cogpit-dummy-timing-pad")` once at module scope) → 401 `Invalid credentials`.
- Concurrency cap: route the verification through the existing `verifyRemotePassword` helper (rename it `verifyWithCap` or add a sibling) so the 2-at-a-time scrypt DoS guard covers user logins too; `busy` → 429.
- `user.disabled` → 403 `{ valid:false, error:"Account disabled" }` (after password verification, to avoid user-enumeration via status codes on bad passwords).
- Success → `createSessionToken(remoteAddr, userAgent, { userId: user.id, username: user.username, role: user.role })` → same browser-cookie / machine-token fork as today (lines 163-170).
- Personal edition path: byte-identical behavior (regression-pinned by existing tests).

**Steps:** failing tests (JSON login ok → cookie for browser client over HTTPS-forwarded request; Bearer `user:pass` ok → token in body; bad password → 401; unknown user → 401 (and both take the scrypt path — assert via timing is flaky, instead assert `verifyPasswordAsync` called via spy or accept behavioral-only); disabled → 403; bare Bearer password (no colon) → 401 in team edition; local request without credentials → 401 in team edition; rate limit still applies) → implement → green → commit `feat(team): username login flow`.

**Status: DONE.** Deviations: `DUMMY_HASH` is a module-scope cell computed lazily on the first unknown-user login — hashing at import time would tax every boot, personal edition included; `verifyRemotePassword` is reused unrenamed (it is already generic over password+stored). The cookie/token fork is extracted as exported `issueSessionResponse` ahead of Task 9's bootstrap reuse. Review hardening rode along: a pin test proving POST `/api/config` cannot inject `edition` into a config that has none.

---

### Task 9: `/api/me` + team management routes

**Files:**
- Create: `server/routes/team.ts` (route id `team-admin` — the id `teams` is taken by agent-teams)
- Create: `server/team/capabilities.ts`
- Modify: `server/api-routes.ts` (register), `server/team/policy.ts` (entries), `server/app-server.ts` + `server/api-plugin.ts` (add `/api/me` and `/api/team/bootstrap` to the NOT_CONFIGURED 503-gate allowlist next to `/api/config`, `/api/notify`, `/api/hello`)
- Test: `server/__tests__/team-routes.test.ts`

**Spec — `server/team/capabilities.ts`:**

```ts
import { ALL_CAPABILITIES, MEMBER_CAPABILITIES, type Capabilities } from "../../shared/contracts/team"
import type { SessionPrincipal } from "../security"
export function computeCapabilities(principal: SessionPrincipal | null, edition: CogpitEdition): Capabilities {
  if (edition === "personal") return ALL_CAPABILITIES
  if (principal?.role === "admin") return ALL_CAPABILITIES
  return MEMBER_CAPABILITIES
}
```

**Spec — routes (all mounted by `registerTeamAdminRoutes(use)`):**
- `GET /api/me` → `MeResponse`. Personal: `{ authenticated: true, edition: "personal", user: null, capabilities: ALL }`. Team: principal from `getRequestPrincipal` → user record → `{ authenticated: true, edition: "team", user: TeamUserPublic, capabilities }`.
- `POST /api/team/bootstrap` — body `{ username, password, displayName? }`. Only while `userCount() === 0`; otherwise `410 { error: "Already bootstrapped" }`. **Race-safe:** serialize through a module-level single-flight promise so two concurrent calls cannot both create admins (second sees count>0 → 410). Creates role `"admin"`, then immediately issues a session (same cookie/token fork as login) so the founder lands logged-in. Validation errors (`UserValidationError`) → 400 with message. The trusted-mutation-source requirement is enforced upstream in `authMiddleware`'s carve-out (cross-origin browser sources → 403 before the route runs), so the route needn't re-check it — but it MUST still re-check `userCount()` inside the single-flight as above.
- `GET /api/team/users` → `{ users: listUsers() }`.
- `POST /api/team/users` — `{ username, password, role, displayName? }` → create → `{ user }`; 400 on `UserValidationError`.
- `PATCH /api/team/users/:id` — accepts `{ disabled?, role?, password? }`; disable/role-change/password-reset call `revokeSessionsForUser(id)`; "last admin" errors → 400.
- Policy entries: `me` paths `authed`... precisely: `team-admin` id → rules `[{prefix:"/api/me", requires:"authed"}, {prefix:"/api/team/bootstrap", requires:"public"}, {prefix:"/api/team/", requires:"admin"}]` (longest-prefix ordering puts bootstrap above the admin catch-all; authMiddleware already gates bootstrap by zero-users, the policy `public` just keeps authz out of the way).
- Register in `API_ROUTE_REGISTRY` right after `apiRoute("config", …)`.

**Steps:** failing tests (me personal shape; me team member shape incl. MEMBER_CAPABILITIES; bootstrap creates admin + issues token + second call 410; concurrent bootstrap race → exactly one admin; member GET /api/team/users → 403 via authz; admin create/disable member; disable revokes sessions — validate token invalid after; parity test auto-covers the policy entry) → implement → green ✋ full suite → commit `feat(team): /api/me, bootstrap, and user management routes`.

**Status: DONE.** Deviations: `/api/team/*` management surfaces answer 404 `Team edition only` in personal edition instead of erroring deep inside the never-initialized users store; `computeCapabilities` takes `SessionPrincipal` from `team/constants` (Task 5's cycle-guard home, not `../security` as sketched); an app-server integration test pins the 503-gate exemption for `/api/me` + bootstrap. Users-store review hardening rode along: per-record shape validation on load (string id/username + recognized password hash, else fail closed), allow-list `toPublicUser()` projection replacing the block-list destructures, displayName trim/cap-64/reject-empty, and `commitUserMutation` refusing an uninitialized store.

---

### Task 10: Boot wiring + shells

**Files:**
- Modify: `server/standalone.ts`, `server/lib/standalone-bootstrap.ts`, `server/app-server.ts` (or wherever composition learns the shell — follow how `mode: HubMode` already flows), `electron/server.ts` or `electron/server-worker.ts` (init personal), `server/api-plugin.ts` (init personal/dev)
- Test: extend `server/__tests__/standalone-bootstrap.test.ts`

**Spec:**
- Each shell calls `initEdition({ shell, configEdition: loadedConfig?.edition })` during composition, before routes register. Electron passes `"electron"`, api-plugin `"dev"`, standalone `"standalone"` — Task 2's forcing makes the first two personal unconditionally.
- `server/standalone.ts` team-edition boot rules (pure helpers go in `standalone-bootstrap.ts`):
  - Team edition **does not require** `COGPIT_NETWORK_PASSWORD` to bind non-loopback (user auth replaces it). The existing personal fail-closed stays for personal.
  - If team edition + `userCount() === 0` after `initUsersStore`: print a prominent banner — `Team edition: no users yet. Open <url> to create the first admin.` and continue binding (only hello/auth/bootstrap are reachable, per Task 6).
  - If a network password env IS set in team edition, log that it is ignored in team edition (avoid silent confusion).
  - Init order in standalone: `setDataRoot` → `setConfigPath` → `loadConfig` → `initEdition` → `initUsersStore(getDataRoot() + "/team")` → `initSessionPersistence(...)` → rest. Mirror the minimal version of this in `createServerComposition` so Electron/dev (personal) skip team stores entirely (guard with `isTeamEdition()`).
- Also: in `server/routes/hello.ts`, add `edition: getEdition()` to the payload (tiny; fold into this task). Update its test.

**Steps:** failing tests (bootstrap helpers: team+non-loopback+no password → allowed; personal+non-loopback+no password → still fails closed (regression pin); hello payload carries edition) → implement → green → commit `feat(team): standalone team boot, shell forcing, hello edition`.

**Status: DONE.** Deviations/notes:
- Composition (`createServerComposition`) owns the canonical init order (setDataRoot → setConfigPath → loadConfig → initEdition → team stores → registry → routes); `server/standalone.ts` additionally calls `initEdition` right after its own loadConfig because the fail-closed decision needs the edition pre-composition (same-input duplicate, mirroring the existing setConfigPath/loadConfig re-run).
- `shouldFailClosed` gained an optional `edition` param defaulting to `"personal"` — 2-arg callers keep fail-closed semantics (regression-pinned).
- In team edition a set COGPIT_NETWORK_PASSWORD is neither strength-checked nor applied — only logged as ignored via pure `buildTeamBootNotices` (which also builds the zero-users first-admin banner).
- Review follow-ups landed here: (1) a corrupt users store rejects `createServerComposition` (pinned in app-server.test.ts against both malformed-shape and unparseable files) and standalone exits 1 via a `.catch` on the composition; (2) suppressed team requests print one boot warning via pure `describeEditionSuppression` (wrong shell / unrecognized value; an explicit valid `COGPIT_EDITION=personal` override is honored silently), logged from app-server + api-plugin so every shell reports exactly once; also added the `resolveEdition({}, "TEAM", "standalone") → personal` config-garbage pin.
- Accepted (no code change): in team edition, POST /api/config networkAccess/password revocations still call `revokeAllSessions`, which wipes team sessions too — fail-safe, users just re-login.
- No dedicated api-plugin test exists (none did before); the dev-shell forcing is pinned at the resolveEdition/initEdition level.

---

### Task 11: Hub user-auth (add a team device from personal Cogpit)

**Files:**
- Modify: `server/hub/registry.ts` (HubDevice + validation + serialization), `server/hub/device-client.ts` (mint), `server/routes/devices.ts` (probe/add/patch passthrough)
- Test: extend `server/__tests__/` hub/device tests (locate: `rg -l "device-client|HubDevice" server/__tests__`)

**Spec:**
- `HubDevice` gains `username?: string`. `listDevices()` keeps stripping `password` but MAY include `username`. Persisted like the rest of `devices.local.json`.
- `device-client.ts` mint: when `device.username` is set, send `Authorization: Bearer ${device.username}:${device.password}` (device password field holds that user's password). No colon-escaping needed — usernames reject `:` (Task 4).
- `routes/devices.ts`: `POST /api/hub/devices` + `PATCH /:id` accept optional `username` (string, trimmed, lowercased); `verifyDevicePassword` includes it in the Bearer when present; surface the device's 403 "Account disabled" / 401 distinctly as `BAD_PASSWORD` (existing code paths).
- Nothing else changes — the proxy, token cache, re-mint, 401→502 mapping are identical.

**Steps:** failing tests (registry round-trips username; mint sends `user:pass` Bearer when username present, bare password otherwise — assert via the mocked fetch/request the existing tests use; add-device passes username through) → implement → green ✋ full suite → commit `feat(team): hub devices authenticate as a named user`.

**Status: DONE.** Deviations/notes: `username` is stored only for `auth: "password"` devices and cleared alongside the password when a device switches to `auth: "none"`; a PATCH that changes only the username still counts as a sensitive change (token invalidated, device re-probed) and re-verifies with the stored password so a typo'd user fails at edit time, not on the next proxy call; a device 403 whose body says `Account disabled` surfaces as new code `ACCOUNT_DISABLED` (distinct from `NETWORK_DISABLED`, which keeps its meaning for personal devices) — the renderer shows the server's `error` string, so no client change was needed.

---

### Task 12: Renderer — team login

**Files:**
- Modify: `src/components/LoginScreen.tsx`, `src/hooks/useNetworkAuth.ts`
- Test: extend the existing tests for both (locate: `rg -l "LoginScreen|useNetworkAuth" src/**/__tests__`)

**Spec:**
- Both need the edition before auth: fetch `/api/hello` (public, unprefixed — use `hubFetch` or raw fetch matching the file's existing bootstrap style) once; cache in module or hook state.
- `useNetworkAuth`: today it only gates when `isRemoteClient()`. New rule: gate when `isRemoteClient() OR hello.edition === "team"` (a localhost browser against a team server must still log in; the server would 401 it anyway — this makes the client render LoginScreen instead of an error).
- `LoginScreen`: when edition is team, render a username field above password; submit as `POST /api/auth/verify` with JSON body `{ username, password }` + `X-Cogpit-Client: 1` + `credentials: "same-origin"` (match the existing fetch call at ~line 26 — keep the Bearer flow for personal). Show server `error` strings verbatim (they're user-facing).
- Keep the existing "clear password from state after submit" behavior; clear username only on success.

**Steps:** failing tests (team hello → username field rendered; personal → no username field; team submit posts JSON body; useNetworkAuth gates on team even when local) → implement → green → commit `feat(team): username login screen`.

---

### Task 13: Renderer — capabilities, gates, identity-scoped keys

**Files:**
- Create: `src/hooks/useMe.ts`, `src/lib/capabilities.ts`
- Modify: `src/contexts/AppContext.tsx` + `src/App.tsx` (thread `me`), `src/lib/device.ts` (`deviceScopedKey`), gate call sites (locate precisely: `rg -n "isRemoteDeviceActive" src/` shows the pattern + `rg -n "Terminal|ScriptsDock|DevicesDialog|kill-all" src/components` for surfaces)
- Test: `src/hooks/__tests__/useMe.test.ts` (follow neighboring hook-test style), extend `src/lib/__tests__/device.test.ts`

**Spec:**
- `useMe`: fetch `/api/me` via `authFetch` on mount and on `cogpit-auth-changed` (copy the listener pattern from `useAppConfig`). While loading / on failure → `{ authenticated: true, edition: "personal", user: null, capabilities: ALL_CAPABILITIES }` (personal parity; a team server enforces server-side regardless). On success, call `setActiveIdentity(user?.id ?? null)` (below).
- `src/lib/capabilities.ts`: module cell — `setMe(me)` called by useMe; `can(cap: keyof Capabilities): boolean` reads it (defaults ALL). Inline render-time gating like `isRemoteDeviceActive()`.
- Thread `me` onto `AppContext` (one field), and apply gates:
  - `can("terminal")` → hide the PTY/terminal affordances + ScriptsDock launch surfaces.
  - `can("configWrite")` → hide network/config editing sections (ConfigDialog) — read-only view is fine.
  - `can("manageDevices")` → hide DeviceSwitcher "Add/Manage devices…" entries + DevicesDialog.
  - `can("killAny")` → hide kill-all / system-process kill buttons.
  - Member with all-defaults (personal) → zero visual change (pin with a test on `can()` defaults).
- `src/lib/device.ts` `deviceScopedKey(base)`: incorporate active identity — `` `${base}::${deviceId}::${userId}` `` when a team userId is set (personal/no-user → exactly today's output, byte-identical, so existing localStorage survives). Add `setActiveIdentity(userId | null)` + `__resetForTest`.

**Steps:** failing tests (useMe fetch/refresh/failure-default; can() defaults true; deviceScopedKey unchanged without identity, scoped with; a representative gate hides on member capabilities) → implement → green ✋ full suite → commit `feat(team): capability-gated renderer and identity-scoped storage`.

---

### Task 14: Final gates + docs touch-up

**Steps:**
1. `bun run lint && bun run typecheck && bun run typecheck:tests` → fix anything.
2. `bun run check:architecture && bun run check:duplicates` → fix (no new cross-layer edges; team modules live in `server/team/` + `shared/contracts/`).
3. `bun run test` ✋ full suite green.
4. `bun run build:web` → green.
5. Update `docs/self-hosting.md`: new "Team edition" section — env `COGPIT_EDITION=team`, bootstrap flow, users API, hub add-as-user, the ignored-network-password note. Update the env-var table (it claims to be exhaustive).
6. Commit `docs: team edition self-hosting guide` and a final `chore: team edition core gates green`.

---

## Explicitly out of scope (next plans)

Workspaces + path scoping (Phase 2) · sharing/audit/usage (Phase 3) · plugin-api + App.tsx decomposition + flows (Phase 4) · admin UI (Phase 5).

## Execution notes

- Tasks 1–5 are dependency-ordered; 6–9 depend on 2/4/5; 10–11 after 6–9; 12–13 after 10; 14 last. Within those constraints, 11 can run parallel to 12/13.
- Every task's tests must run in personal edition too (`__resetEditionForTest` hygiene in afterEach) — the personal regression pins are as important as the team features.
