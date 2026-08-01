# Mission Control — design

A full center-pane grid of every live agent session, built so sessions blocked on
the user are impossible to miss.

## Why the mockup could not be copied

`marketing/assets/mockups/04-live-sessions.html` is a static fake with standalone
CSS. Three of its core promises are not backed by app data today:

1. **Pending permissions are not in `/api/active-sessions`.** They live in
   `GET /api/permissions/:sessionId`, polled every 2 s — and only ever for the
   *currently open* session (`App.tsx` passes `state.session?.sessionId`).
2. **`classifyAttention`'s `"permission"` reason is a different thing.** It means
   `agentStatus === "deferred"` (a PreToolUse hook returned `decision: "defer"`),
   which is resolved by resuming the session, not by an Allow/Deny button.
3. **Cards need elapsed / tokens / context % / diffstat / tool trail**, none of
   which `/api/active-sessions` returns.

The design below closes all three gaps against real data.

## Architecture

### 1. One inventory, one poll

`LiveSessions/index.tsx` privately owns the session inventory: fetch, abort,
localStorage cache, `newlyCompleted` transition tracking, focus refresh, and
visibility-gated polling. Mission Control needs exactly the same data.

Extract it to `src/contexts/SessionInventoryContext.tsx` (`useSessionInventory`).
`LiveSessions` deletes its local copy and consumes the context; Mission Control
consumes the same one. Two views, one poll — not a second copy of the logic.

### 2. Batch permissions

`server/routes/permissions.ts` gains a bare `GET /api/permissions` that returns
every pending request across all sessions, by enumerating `sdkSessions`,
Codex threads, and `persistentSessions`. The existing per-session GET and the new
batch listing share one extracted `collectPendingPermissions(sessionId)`.

The response POSTs are unchanged and already stateless per session, so a card can
answer a permission without the session being open. The single-session and
all-session hooks share `src/lib/permissionApi.ts` so the respond call exists once.

### 3. Card summaries — incremental, not re-parsed

`GET /api/mission-control` returns a compact summary per recent session.

Naively parsing every live session's JSONL every poll is far too expensive; live
files grow constantly, so an mtime cache alone always misses. Instead
`server/lib/missionControlSummary.ts` keeps a per-file accumulator of
`{ mtimeMs, size, parsedBytes, acc }` and on each poll reads **only the bytes
appended since last time**, folding them into the running totals. A shrunk or
replaced file falls back to a full read. Appends are the normal case, so steady
state cost is proportional to new output, not session size.

Per session: model, elapsed, turns, token totals, context used/limit/pct, current
tool + command, tool trail, total tool calls, changed files with +/- counts, and
the latest assistant text.

### 4. Attention classification, extended not forked

`classifyAttention` takes an optional pending-permission map. A session with a
live request classifies as `"permission"` at top priority. The sidebar attention
strip inherits this for free — it starts catching real permission requests, which
it does not do today.

### 5. Shared diffstat renderers

`LineCounts` and `ChangeBar` are currently duplicated file-locally in
`TurnChangedFiles.tsx` and `GroupedFileCard.tsx`. Lift to
`src/components/shared/ChangeCounts.tsx` and delete both copies rather than
adding a third.

## The view

`src/components/MissionControl/` — `index.tsx` (toolbar + grid), `SessionCard.tsx`,
`PermissionPrompt.tsx`, `missionControlView.ts` (pure, testable filter/sort/format),
`types.ts`.

- Responsive grid, 3 across wide → 1 narrow; grid/list toggle.
- Filters: All / Running / Needs you / Finished.
- Sort: needs-you first (permission → waiting → done), then running, then
  finished; recency within each band.
- Blocked cards render the real pending request inline with working Allow/Deny.
- Header carries an "N need you" count.

Reached via a header toggle and `⌘⇧M`, following the existing `config` view
precedent: `mainView` union, `OPEN_MISSION`/`CLOSE_MISSION` actions,
`resolveDesktopMainView` branch, lazy-loaded render branch.

## Constraints discovered

- `animate-pulse` / `animate-ping` are globally disabled (`animation: none
  !important`) for GPU reasons. The live pulse uses the existing `.live-pulse`.
- shadcn here is the **Base UI** variant: `render={...}`, not `asChild`.
- There is no `Progress` primitive; the context bar is hand-rolled.
- Cards use `bg-elevation-2` and the real elevation tokens, not mockup CSS.

## Deliberately out of scope

The right-rail cross-session activity feed is treated as stretch, per the brief.
