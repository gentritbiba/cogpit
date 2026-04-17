# Session Switching: Ultra-Fast

**Goal:** Session switching in Electron must feel instant. Every click between sessions in the sidebar/dashboard should render within one animation frame whenever possible, and never block more than ~50 ms when the cache is cold.

## Context

The previous perf redesign (2026-04-07) introduced web-worker parsing, `?tail=30` bottom-first loading, an LRU cache, and a virtualized timeline. Switching still lags in Electron (not in the dev browser). The browser-vs-Electron gap pinpoints the root cause: **main-process contention**. In Electron, the renderer and the Express server run in the same process tree, so disk I/O and JSON (de)serialization inside the bundled Node server compete for the same CPU that paints frames. Anything we can do to cut waste or start work earlier multiplies in Electron.

## Remaining bottlenecks (verified against current code)

1. **Duplicate parse.** `useLiveSession.ts` re-parses `rawText` in an effect even though `useSessionActions` already parsed it via the web worker. Every switch does the parse twice.
2. **SSE reconnect on every rawText change.** The EventSource effect has `rawText` in its dependency array, so every switch tears down and re-opens the connection (~100–500 ms setup). Even cache hits pay this tax.
3. **Team switches bypass the tail endpoint.** `handleOpenSessionFromTeam` and `handleTeamMemberSwitch` call `fetchFullAndParse`, so team members with big sessions still pull the entire file.
4. **No prefetch.** Cache only fills on actual visit. First click to any session not in the last five visited pays the full HTTP + parse cost.
5. **Dispatch on the critical path.** `LOAD_SESSION` kicks a massive React re-render (virtualizer re-measure, context menu wiring, undo graph build). Not scheduled as a transition, so it can block input for a frame.

## Fixes (in priority order)

### Fix 1 — Don't parse the same text twice

`useSessionActions` already produces a `ParsedSession` via the worker. Accept an optional `initialParsed` on `useLiveSession` and seed `sessionRef.current` synchronously when the source changes. Only invoke the worker if we don't already have a parse for the current `rawText`.

### Fix 2 — Only reconnect the stream when the stream target changes

Drop `rawText` from the SSE `useEffect` deps. Reconnect only when `dirName`/`fileName` change. For cases where a reload *must* reset the stream (truncation after undo), bump an explicit `reloadKey` in state and read that instead.

### Fix 3 — Team fetches use `?tail=30`

Swap `fetchFullAndParse` for `fetchTailAndParse` in the two team handlers. Also populate the LRU cache on team-open so the chunked "load more" path stays consistent.

### Fix 4 — `startTransition` for session loads

`dispatch({ type: "LOAD_SESSION", … })` is wrapped in `startTransition` (and sibling `LOAD_SESSION_FROM_TEAM`, `SWITCH_TEAM_MEMBER`). React can then keep input/scroll responsive while the heavy tree rebuilds. The live-session `UPDATE_SESSION` path already uses `startTransition`; this extends the same treatment to the switch path.

### Fix 5 — Hover-intent prefetch

Add a `prefetchSession(dirName, fileName)` helper that:
- Returns early if already cached.
- Issues `authFetch(..?tail=30)` and parses via the worker in the background.
- Stores into the LRU on success.

Wire a `onMouseEnter` delay (~120 ms) + `onFocus` handler on session rows (sidebar live list, session browser, dashboard). By the time the user clicks, the entry is in the cache and the switch is literally a state dispatch.

### Fix 6 — Idle warm-up

On app boot, after the initial dashboard fetch, use `requestIdleCallback` (fallback: `setTimeout(..., 0)`) to prefetch the top 5 "Live & Recent" sessions. Bounded to 5 to respect the LRU cap.

## Non-goals

- No server protocol changes. Tail endpoint already exists and is fast enough.
- No render-tree refactor. Virtualizer already pays for itself once data is ready.
- No new dependencies.

## Success criteria

- Repeat switch between two sessions (both cached) dispatches `LOAD_SESSION` with zero additional HTTP, zero extra parses, and keeps the SSE open when `dirName`/`fileName` are unchanged across a reload.
- First visit to a session the user has hovered for ≥120 ms is indistinguishable from a cached hit.
- Existing tests in `src/hooks/__tests__/useLiveSession.test.ts` and `useSessionActions.test.ts` pass after adaptation.
- `bun run test` green, `bun run build` green.
