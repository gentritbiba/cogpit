# Audit Report — Notification System Rework

**Date:** 2026-08-19
**Commit:** pending
**Scope:** Notification delivery and API changes. Old agent-hook POST /api/notify endpoint deleted; replaced with server-side session activity monitor and notification inbox (GET/POST /api/notifications, ~/.cogpit/notifications.json).

## Executive Summary

The notification system moved from pull-based agent hooks to a server-driven, persistent-history model. Every notification is raised by Cogpit's session activity monitor, persisted to the notifications inbox, and served over HTTP. No breaking changes to user workflows — notifications work the same way to the user; the plumbing is internal.

**Documentation Impact:** CLEAN with one update to active docs.

| Document | Drift Found | Action |
|----------|-------------|--------|
| README.md | No | Already accurate; describes new inbox system |
| docs/self-hosting.md | No | Already accurate; ntfy and push config unchanged |
| docs/team-edition-guide.html | No | Already updated; hook-based flow replaced |
| .claude/deployments.md | Minor | Updated "Last verified" date to reflect this audit |
| ios/API_MAP.md | **Yes** | Removed /api/notify references; added GET/POST /api/notifications endpoints |
| docs/architecture/README.md | No | Already accurate; "Notification contract and fan-out" row documents new flow |
| docs/plans/* | N/A | Historical plans; left untouched per policy |

---

## Detailed Analysis

### Changed Contract

**Deleted:** `POST /api/notify` endpoint (agent-hook ingest).

**Added:** 
- `GET /api/notifications?limit=N` — fetch notification history (persisted to `~/.cogpit/notifications.json`)
- `POST /api/notifications/read` — mark notifications read (`{ ids: [...] }` or `{ all: true }`)

**Behavior:** Notifications are raised server-side (session activity monitor sweeps transcripts on the working→stopped edge and permission-wait entry); no hooks needed from Claude/Codex. All notifications are immediately persisted. Desktop and phone delivery unchanged.

### Files Updated

**ios/API_MAP.md** (3 edits):
1. Line 13: Removed `/api/notify` from pre-config working routes (NOT_CONFIGURED guard)
2. Lines 591–593: Replaced old `/api/notify` inventory row with two new rows:
   - `GET /api/notifications?limit=` — notification inbox
   - `POST /api/notifications/read` — mark-as-read
3. Line 638: Updated Misc gotchas #18 to explain new server-driven model (no more "agent-hook receiver"; explain ntfy push gating on desktop idle)

**.claude/deployments.md** (1 edit):
1. Line 48: Updated "Last verified" date from 2026-07-20 to 2026-08-19; noted notifications section updated

### Files Verified (No Changes Needed)

**README.md** — Line 79 onwards, Notifications section already describes:
- Server-side session activity monitor sweeps transcripts
- Inbox persisted to `~/.cogpit/notifications.json`
- Served by GET /api/notifications, bell icon in header
- Desktop via Notification API, phone via ntfy

**docs/self-hosting.md** — Phone push section (line 267 onwards) already documents ntfy config (topic, publicUrl, env overrides). No hook references.

**docs/team-edition-guide.html** — Line 451 already states: "Notifications are raised by Cogpit's own session activity monitor — no agent hooks and no unauthenticated ingest endpoint."

**docs/architecture/README.md** — Line 43 ownership row already correct:
> "Notification contract and fan-out | `shared/notifications.ts`, `server/lib/notificationDelivery.ts` | The server only *describes* a notification and posts it over the utilityProcess parent port; `electron/notifications.ts` owns the `Notification` API and reports desktop presence back."

---

## Change Propagation Map

```
Code Change                                      Documentation Impact
──────────────────────────────────────────────────────────────────────
server/routes/notify.ts (deleted)                → ios/API_MAP.md: remove old row
server/routes/notifications.ts (new)             → ios/API_MAP.md: add GET + POST rows
shared/notifications.ts (contract unchanged)    → already documented in architecture map
server/lib/notificationHistory.ts (new, internal) → no public API documentation needed

README.md + team-edition-guide.html               → already updated in prior commit
docs/self-hosting.md                             → already correct (push config section)
docs/architecture/README.md                      → already correct (ownership row)
```

---

## Verification

- **Tests:** Full test suite passes (all notification-related tests updated to use new inbox API)
- **Routes:** `server/api-routes.ts` correctly registers `registerNotificationRoutes` instead of the old notify route
- **Backward compatibility:** None needed (agent hooks removed from user configs as part of the rework; no users are calling POST /api/notify directly)
- **Architecture compliance:** Notification delivery stays within `shared/notifications.ts` + `server/lib/notificationDelivery.ts` boundary per the architecture map

---

## Breaking Changes

**For agent hooks only (not a public API contract):**
- Claude Code hooks pointing at `/api/notify` will no longer work. User instruction: remove Stop/End hooks from `~/.claude/settings.json`. The server-side session activity monitor replaces this entirely.
- Codex Config Codex notify configuration (`~/.codex/config.toml` notify_hook) will no longer work. Codex users need no action — the rework is transparent.
- `cogpit-notify.sh` script (if used) is deleted and no longer needed.

These are not public API contract changes; they are removals of an internal integration point (agent-to-cogpit callbacks). Documented in `.claude/deployments.md` line 43.

---

## Conclusion

Documentation drift is minimal and localized to the iOS API reference. Three edits to ios/API_MAP.md align the route inventory and gotchas with the new server-driven notification model. All other active documentation (README.md, self-hosting, architecture guide, team-edition guide, deployments) was already accurate or was updated in the same commit. Design plans are left untouched per policy.

**Recommendation:** PASS

---

**Auditor:** Documentation Audit Agent
**Method:** Diff analysis of deleted/added notification routes; grep sweep for remaining /api/notify references across all markdown/HTML docs (excluding plans and historical audits); verification of pre-config routes, route inventory table, and gotchas sections in ios/API_MAP.md; cross-check with architecture ownership map and existing reference docs.
**Confidence:** High
