# Codebase Cleanup, Performance, and Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Address all findings from the 2026-05-07 4-agent codebase audit (cleanup, performance, refactor, architecture).

**Architecture:** Tasks are sequenced from low-risk quick wins → performance fixes → subprocess hardening → standardization → larger refactors. Each task is independently committable. We work on `master` directly per project convention; each task is its own commit so any can be reverted in isolation.

**Tech Stack:** TypeScript, Electron, Vite, React, Express-style server (port 19384), Bun for runtime/tests.

---

## Phase 1 — Quick Wins (Cleanups)

### Task 1.1: Remove deprecated `SessionSourceKind` alias

**Files:**
- Modify: `src/lib/sessionSource.ts:15`

**Steps:**
1. Read `src/lib/sessionSource.ts` to confirm `SessionSourceKind` is unused outside the file
2. Run `grep -rn "SessionSourceKind" src/ server/ electron/` to verify zero callers
3. Delete the alias export
4. Run `bun run test` and `bun run build` (or equivalent type check)
5. Commit: `chore: remove unused SessionSourceKind alias`

### Task 1.2: Remove deprecated "Task" tool color references

**Files:**
- Modify: `src/lib/parser.ts:234`
- Modify: `src/components/BranchModal/branchStyles.ts:17`
- Modify: `src/components/timeline/ToolCallCard.tsx:26`

**Steps:**
1. Verify "Task" tool name no longer exists (renamed to "Agent" pre-v2.1.63)
2. Remove `Task: ...` entries from each file's color/badge map
3. Run tests + build
4. Commit: `chore: remove deprecated Task tool color mappings`

### Task 1.3: Consolidate duplicated `TOOL_BADGE_STYLES`

**Files:**
- Read: `src/components/BranchModal/branchStyles.ts:10`
- Read: `src/components/timeline/ToolCallCard.tsx:17`
- Decide single canonical location (likely a new shared module under `src/components/timeline/badgeStyles.ts` or extending `branchStyles.ts`)

**Steps:**
1. Compare both definitions; decide canonical color values (low-contrast vs high-contrast). Default to keeping BranchModal's because `branchStyles.ts` is already a "styles" module.
2. Move definition into `src/lib/toolBadgeStyles.ts` (new shared util)
3. Update both consumers to import from shared module
4. Run tests + build
5. Commit: `refactor: extract shared TOOL_BADGE_STYLES to src/lib/toolBadgeStyles.ts`

---

## Phase 2 — Critical Bug Fixes

### Task 2.1: Fix search index path mismatch (dev vs prod)

**Files:**
- Modify: `server/api-plugin.ts:54` (dev path is hardcoded `~/.claude/agent-window/search-index.db`)
- Modify: `electron/server.ts:51` (prod path uses `userDataDir/search-index.db`)
- Possibly modify: `server/standalone.ts` (uses `$COGPIT_DATA_DIR`)

**Steps:**
1. Read all three files; understand current path logic
2. Decide canonical resolution: env var > userDataDir param > sensible default
3. Extract a shared `resolveSearchIndexPath(opts)` helper into `server/paths.ts` (new file)
4. Update both api-plugin.ts and server.ts to use the helper
5. Replace the 1-second `setTimeout` race with a proper `await` on initialization
6. Run tests + build
7. Commit: `fix: unify search index path resolution between dev and production`

### Task 2.2: Fix Map iteration race + O(n²) pid lookup in claude-manage.ts

**Files:**
- Modify: `server/routes/claude-manage.ts:80-93, 96, 129-134, 324-331`

**Steps:**
1. Read full file to understand `activeProcesses`, `persistentSessions`, `trackedByPid` structures
2. Add a failing test in `server/__tests__/routes/claude-manage.test.ts` that simulates kill-all with 3+ active sessions and verifies no concurrent-modification issue
3. Build a `pid → sessionId` Map upfront before the iteration loop
4. Snapshot via `[...map.entries()]` before mutating
5. Replace nested `.find()` with direct Map lookup
6. Replace `[...persistentSessions.values()].map(...).concat([...activeProcesses.values()])` with single push loop
7. Run tests until green
8. Commit: `perf: eliminate Map iteration race + O(n²) lookup in claude-manage`

### Task 2.3: Convert blocking sync I/O in search-index.ts to async [DONE - commit 9a94d98]

**Files:**
- Modify: `server/search-index.ts:105` (`readFileSync` → async)
- Modify: `server/search-index.ts:421` (`readdirSync`/`statSync` discovery loop)
- Modify: `server/search-index.ts:564` (debounced reindex `statSync`)

**Steps:**
1. Read the file; understand `indexFile()`, `discoverFiles()`, `debouncedReindex()` flow
2. Add (or extend) a test in `server/__tests__/search-index.test.ts` covering large file indexing
3. Convert `readFileSync` → `await fs.readFile`, mark function `async`
4. Replace nested sync directory walk with `Promise.all` + bounded concurrency (limit 8)
5. Verify caller chains all `await` correctly
6. Run tests + build
7. Commit: `perf: convert search-index sync I/O to async`

### Task 2.4: Add metadata caching to activeSessionsRoute ✅ DONE (9eb1f6c)

**Files:**
- Created: `server/lib/sessionMetaCache.ts` — TTL=8s, keyed by filePath+mtimeMs
- Created: `server/__tests__/lib/sessionMetaCache.test.ts` — 9 tests, all pass
- Modified: `server/routes/projects/activeSessionsRoute.ts` — cache check before getSessionMeta/getSessionStatus
- Modified: `server/search-index.ts` — added `onFileChanged` callback hook
- Modified: `server/api-plugin.ts`, `electron/server.ts` — wired invalidateSessionMeta

### Task 2.5: Optimize duplicate Map lookups + array allocations in claude-manage.ts

**Files:**
- Modify: `server/routes/claude-manage.ts:35-56, 96`

**Steps:**
1. Replace `.get` + `.get` + `.has` triple-lookups with single `.get` + truthy check
2. Replace array spread+concat with single push loop in kill-all
3. Run existing tests
4. Commit: `perf: reduce redundant Map lookups in claude-manage stop-session`

### Task 2.6: Move case-sensitive search filter into SQL GLOB

**Files:**
- Modify: `server/search-index.ts:273-275`

**Steps:**
1. Read the FTS5 query; understand current `.filter().includes()` post-filter
2. Add test asserting case-sensitive search returns only exact-case matches
3. Replace post-filter with `WHERE content GLOB ?` in the SQL
4. Verify performance + correctness
5. Commit: `perf: move case-sensitive search filter into SQL GLOB`

---

## Phase 3 — Subprocess Lifecycle Hardening

### Task 3.1: Add SIGTERM → SIGKILL escalation + cleanup logging [DONE - 079024e]

**Files:**
- Modify: `server/helpers.ts:487-497` (`cleanupProcesses`)

**Steps:**
1. Read `cleanupProcesses` and trace all callers
2. Add failing test in `server/__tests__/helpers.test.ts`: process refusing SIGTERM should be killed by SIGKILL escalation within 5s
3. Wrap cleanup with structured logger; capture errors instead of silent swallow
4. After SIGTERM, schedule SIGKILL after 3000 ms if process still alive
5. Run tests + build
6. Commit: `fix: escalate SIGTERM→SIGKILL and log cleanup failures`
<!-- Done: snapshot pattern, SIGTERM→SIGKILL 3s, console.error logging, unref timer, 11 new tests -->

### Task 3.2: Add tests for session-spawn crash + timeout scenarios

**Files:**
- Create: `server/__tests__/routes/claude-new-spawn.test.ts`

**Steps:**
1. Mock spawn to simulate (a) immediate exit, (b) hang past timeout, (c) exit during `writeTempImageFiles`
2. Assert `persistentSessions` and `activeProcesses` end up empty in all 3 cases
3. Assert temp files cleaned up
4. Commit: `test: add subprocess crash/timeout coverage for session spawning`

---

## Phase 4 — API Response Standardization

### Task 4.1: Introduce `RouteError` type + standard error response helper

**Files:**
- Create: `server/lib/routeError.ts`
- Modify: `server/helpers.ts` (export `sendError(res, error, status)` helper)

**Steps:**
1. Define `RouteError { code: string; message: string; details?: unknown }`
2. Define `sendError(res, err: RouteError | Error, status?)` that writes consistent shape `{ error, code, details? }`
3. Add test
4. Commit: `feat: add RouteError type and sendError helper`

### Task 4.2: Migrate top 5 most-called routes to standardized errors

**Files:**
- Modify: `server/routes/claude.ts`
- Modify: `server/routes/claude-manage.ts`
- Modify: `server/routes/claude-new/sessionSpawner.ts`
- Modify: `server/routes/projects/activeSessionsRoute.ts`
- Modify: `server/routes/files.ts`

**Steps:**
1. Replace ad-hoc `{ error: "..." }` returns with `sendError()` calls
2. Verify response shape via tests
3. Commit: `refactor: standardize error responses in core routes`

---

## Phase 5 — Type Safety & Reuse Improvements

### Task 5.1: Extract duplicated message-type guards

**Files:**
- Create: `src/lib/messageTypeGuards.ts`
- Modify: `src/lib/turnBuilder.ts`
- Modify: `src/lib/parser.ts`

**Steps:**
1. Find guards (`isUserMessage`, `isAssistantMessage`, etc.)
2. Move into `messageTypeGuards.ts`
3. Update both files to import
4. Run tests
5. Commit: `refactor: deduplicate message type guards`

### Task 5.2: Add `useLocalStorage` hook

**Files:**
- Create: `src/hooks/useLocalStorage.ts`
- Modify: `src/components/FileChangesPanel/index.tsx` (and other usages)

**Steps:**
1. Find all `localStorage.getItem`/`setItem` usages in src/
2. Implement `useLocalStorage<T>(key, defaultValue)` hook with JSON serialization + SSR safety
3. Migrate FileChangesPanel preferences to use it
4. Migrate any other call sites discovered
5. Run tests
6. Commit: `refactor: extract useLocalStorage hook`

---

## Phase 6 — Security Improvements

### Task 6.1: Hash `networkPassword` at rest

**Files:**
- Modify: `server/config.ts:40`
- Modify: `electron/server.ts:148` (validation site)
- Modify: `server/security.ts` (already has `hashPassword`)

**Steps:**
1. Read existing `hashPassword` implementation
2. Add migration: on read, if password is plaintext (no `$argon2…` or similar prefix), hash and rewrite
3. Update validation site to compare against hash
4. Add test for both fresh hash creation and verification
5. Commit: `security: hash networkPassword at rest with migration`

---

## Phase 7 — Larger Refactors (Defer to Later Session)

These are tracked but NOT executed in this run because of scope. Each is a multi-day project deserving its own brainstorming + worktree.

- **Task 7.1:** Split `src/App.tsx` (1359 lines) into container hierarchy
- **Task 7.2:** Split `server/helpers.ts` (536 lines) into 4 domain modules
- **Task 7.3:** Split `src/lib/codex.ts` (696 lines) into modular parser
- **Task 7.4:** Add JSON schema validation (zod) to all body-parsed routes
- **Task 7.5:** Add tests for all 12 untested route handlers

---

## Execution Notes

- Run between every task: `bun run test` + `bun run build` (or whatever the project uses for type-check)
- Each task is a single commit; commit message uses Conventional Commits prefix
- After each task, dispatch `superpowers:code-reviewer` per `subagent-driven-development` skill
- Halt and report if any task introduces test failures that can't be resolved within the task

---

## Verification Checklist (run at end)

- [ ] All Phase 1 tasks committed
- [ ] All Phase 2 tasks committed
- [ ] All Phase 3 tasks committed
- [ ] All Phase 4 tasks committed
- [ ] All Phase 5 tasks committed
- [ ] All Phase 6 tasks committed
- [ ] `bun run test` passes from clean checkout
- [ ] `bun run build` (or equivalent) succeeds
- [ ] `git log --oneline` shows clean atomic commits
- [ ] Phase 7 deferred items are documented for follow-up
