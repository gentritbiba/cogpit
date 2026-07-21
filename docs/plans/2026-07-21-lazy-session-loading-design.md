# Lazy Session Loading — Unify All Open Paths

**Date:** 2026-07-21
**Status:** Approved design

## Problem

Opening a long session is slow. The lazy machinery (tail read, worker parse,
LRU cache, chunked scroll-up) already exists but only the dashboard uses it.
Every other open path reads the **entire JSONL file** and parses it
**synchronously on the main thread**:

| Path | Entry point | Today |
|---|---|---|
| Dashboard / team / prefetch | `useSessionActions`, `sessionPrefetch` | `?tail=30` + worker + cache ✅ |
| Sidebar browser / live list / subagents | `useSessionBrowser.fetchParsedSession` | full read, main-thread parse ❌ |
| URL deep-link / refresh / back-forward | `useUrlSync.loadFromUrl` | full read, main-thread parse ❌ |
| Reload | `useAppHandlers.reloadSession` | full read, main-thread parse ❌ |
| Branch / duplicate | `useAppHandlers.handleBranchFromHere` / `handleDuplicateSessionByPath` | POST branch → full read of new file ❌ |

Server support (`?tail=N`, `?before=&count=`) already exists in
`server/routes/projects/index.ts`.

## Design

### 1. New module `src/lib/sessionLoader.ts`

- Move `fetchTailAndParse` + `loadSessionTailCached` from `useSessionActions.ts`
  (already module-level pure functions).
- Add `loadSessionTailFresh`: delete the `sessionCache` entry, then tail-fetch
  and repopulate — for reload, where the file may have been rewritten
  (rewind/compaction).
- `sessionPrefetch.ts` reuses `fetchTailAndParse` instead of duplicating it.

### 2. Converge all open paths on the loader

- `useSessionBrowser`: replace `fetchParsedSession` with
  `loadSessionTailCached`; hook gains a `workerParse` dependency threaded from
  App. `onLoadSession` receives a complete `SessionSource` (agentKind,
  `watchOffset = totalSize`, rawText = tail).
- `useUrlSync`: same substitution; gains `workerParse`.
- `useAppHandlers.reloadSession`: `loadSessionTailFresh`, dispatch
  `RELOAD_SESSION_CONTENT` with proper `watchOffset`.
- `useAppHandlers` branch/duplicate: after `POST /api/branch-session`, open the
  new file via `loadSessionTailCached` (server owns the copy; client never
  needed the full text).

The no-param whole-file GET remains for the external API and search only.

### 3. Correctness requirements

1. **Live-stream offset.** `useLiveSession` defaults `watchOffset` to
   `byteLength(rawText)` — correct only for full reads. With a tail this would
   re-stream nearly the whole file as "new lines". Every loader result carries
   `watchOffset = totalSize` explicitly.
2. **Reload staleness.** Reload invalidates the cache entry first
   (`loadSessionTailFresh`) so rewritten files never serve stale turns.
3. **Branch-from-here index mismatch** (pre-existing on dashboard, promoted by
   unification). UI sends turn index within *loaded* turns; server counts
   boundaries from *file start* — wrong branch point on tail-loaded sessions.
   Fix: client also sends `turnUuid: turn.id` (boundary user-message uuid);
   `sessionBranching.ts` prefers uuid (locate line by uuid, cut at next turn
   boundary), falls back to `turnIndex` for Codex (no stable uuids).
4. **In-session search** covers only loaded turns. Mitigation: on search
   activation with `hasMore`, chain `loadMore` in the background until fully
   loaded.

Non-issues: stats/context badges compute over the loaded window (matches
dashboard today; the context badge reads the *last* assistant usage — in the
tail). Small files: `?tail=30` returns the whole file with `hasMore=false` —
identical to today. Scroll-up chunking (`useChunkedSession`) keys off
`sessionCache`, which all paths now populate — it starts working everywhere
automatically.

## Implementation order (suite stays green per step)

1. Extract `sessionLoader.ts` (pure refactor).
2. Rewire `useSessionBrowser`.
3. Rewire `useUrlSync`.
4. Rewire `useAppHandlers` (reload, branch, duplicate).
5. Branch `turnUuid` fix (client + `sessionBranching.ts` + tests).
6. Search hydration on activation.

## Tests

- Update: `useSessionActions.test.ts`, `sessionPrefetch.test.ts` (moved
  imports), `useSessionBrowser.cache.test.ts`, `useUrlSync.test.ts` (mock tail
  endpoint, assert worker parse + `watchOffset`),
  `server/__tests__/routes/branch-session.test.ts` (uuid cut, index fallback,
  Codex).
- New: `sessionLoader.test.ts` (cache hit, device-switch guard,
  fresh-invalidate).
- `bun run test` green before completion.

## Verification

Open a long session from sidebar/URL/live-list → instant; scroll up pages in
older turns; live updates don't duplicate turns; branch-from-here on a
tail-loaded session branches at the correct turn.
