# Audit Report — Team Edition Security and Hub Hardening

**Date:** 2026-08-10
**Commit:** `4384f32` (`team-edition`)
**Scope:** Final merge-hardening pass for PR #13: founding-admin bootstrap, role policy, host-file capabilities, PTY and session revocation, persisted expiry, hub authorization and credentials, renderer auth/caching, startup diagnostics, and dependency advisories.

## Contract-level changes

| Change | Documentation surface |
|---|---|
| First-admin creation requires a one-time process-local token carried in a printed URL fragment, or `COGPIT_BOOTSTRAP_TOKEN` for headless setup. | `docs/self-hosting.md`, `docs/team-edition-guide.html` |
| Members cannot access caller-selected host files, diffs, undo, scripts, or git status; the renderer exposes the same `hostFiles` capability boundary. Members may still list and switch hub devices. | `docs/self-hosting.md`, `docs/team-edition-guide.html` |
| Transcript-derived session file changes are also admin-only because they expose absolute paths and exact before/after content. | `docs/self-hosting.md`, `docs/team-edition-guide.html` |
| Raw config-browser and MCP definitions are admin-only because they can contain credentials. Config validation, command expansion, checkpoint restore, and worktree mutations are also admin-only; members retain worktree listing and normal worktree-backed session creation. | `docs/self-hosting.md`, `docs/team-edition-guide.html` |
| Provider runtime/account and aggregate usage responses are admin-only because they expose the shared account, plan, credits, and rate limits. Codex goals and threads remain member-readable session surfaces; the renderer's `viewUsage` capability prevents member polling. | `docs/self-hosting.md`, `docs/team-edition-guide.html` |
| Established local and hub PTYs close when their session is revoked or expires. Persisted logins retain both idle and absolute expiry across restarts. | `docs/self-hosting.md`, `docs/team-edition-guide.html` |
| Vite-development PTYs now use the same ongoing authorization/revocation controller as packaged/standalone PTYs. Team identity lookup failures remain zero-capability instead of falling back to personal parity. | `docs/self-hosting.md`, `docs/team-edition-guide.html` |
| Team servers added as hub devices require a username and password; incomplete team bootstrap is reported before add. | `README.md`, `docs/self-hosting.md`, `docs/team-edition-guide.html` |
| Hub proxy requests are authorized against the downstream API policy before stored device credentials are substituted. | Operator security notes remain accurate; no public endpoint shape changed. |
| Sensitive hub device connection updates use a verified-snapshot conditional commit and tear down established PTY and HTTP streaming tunnels; name-only updates do neither. | Internal connection-integrity behavior; no endpoint shape changed. |
| Authenticated direct and hub-proxied SSE/watch streams terminate when their admitting outer session is revoked or expires. | `docs/self-hosting.md`, `docs/team-edition-guide.html` |
| Hub device summaries carry a monotonic connection revision so same-id host/account changes remount and isolate renderer scopes and caches; name-only updates preserve the revision. | Internal cache-integrity behavior; the device response adds a non-secret numeric field. |
| Invalid persisted edition values continue to fall back to personal edition but now produce the documented startup warning. | Existing team-edition troubleshooting guidance remains accurate. |
| An edition-only team configuration retains `edition: "team"` when the founding admin saves the first full path configuration; team login responses wait for durable session persistence. | Existing setup and restart guidance remains accurate. |
| Electron and transitive overrides were refreshed to remove newly fixable audit findings. | Internal dependency metadata only; no user-facing configuration changed. |

## Files updated

- `README.md` now distinguishes personal network-password credentials from team username/password credentials and names incomplete bootstrap as a probe result.
- `docs/self-hosting.md` documents the setup-token flow, secret-bearing config boundary, host/worktree/provider-usage member policy, restart-stable expiry, and live PTY revocation.
- `docs/team-edition-guide.html` documents the setup token and curl header, exact role/capability boundary including provider usage, fail-closed identity, session/PTY revocation, and troubleshooting response.

## Verified accurate, left unchanged

- `ARCHITECTURE.md` remains a pointer to the canonical ownership map; no ownership layer moved.
- `docs/architecture/README.md` already assigns network trust to `server/security.ts` and server composition to `server/app-server.ts`; the hardening preserves those boundaries.
- No route module was added outside the canonical `server/api-routes.ts` registry.
- Historical plans remain point-in-time design records and were not rewritten.

## Validation evidence

- Full suite: 233 files, 3,560 tests passed.
- Production and test TypeScript checks, ESLint, architecture, duplicate-code, dependency-audit, and shared-module parity gates passed.
- Web, Electron, compiled CLI, npm package, and package-contract builds passed.
- React Doctor findings were reviewed; the changed-scope scan found no new actionable defect in this security batch.

## Verdict

**PASS** — documentation now matches the hardened bootstrap, authorization, hub credential, PTY, and persisted-session behavior. No blocking documentation drift remains.
