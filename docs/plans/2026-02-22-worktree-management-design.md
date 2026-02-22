# Worktree Management for Cogpit

## Overview

Built-in git worktree support so users can run multiple parallel Claude Code sessions on the same repo without file conflicts, plus a management UI to list, create PRs from, and clean up worktrees.

## Architecture

Three layers:

1. **Spawn layer** (backend) — Appends `--worktree <name>` to Claude CLI spawn args when the user opts in. Changes touch `server/routes/claude-new.ts` and `server/routes/claude.ts`.
2. **Data layer** (backend) — New routes that call `git worktree list --porcelain` and `git status` to provide structured worktree data. Session-to-worktree linking derived from `gitBranch` matching the `worktree-<name>` convention.
3. **UI layer** (frontend) — Worktree toggle on session creation, sidebar badges on worktree sessions, and a dedicated Worktree Management panel.

## Session Creation Flow

1. User clicks "New Session" on a git-backed project.
2. Below the message input, a "Use worktree" toggle appears (off by default, configurable per-project).
3. User types their first message and hits send.
4. Cogpit generates a worktree name from the message — slugified, truncated to ~40 chars (e.g. "Fix the auth token refresh logic" -> `fix-auth-token-refresh-logic`). An editable chip shows the name inline.
5. Backend receives request with `worktreeName` field. Spawn args become:
   ```
   claude -p --worktree <name> --input-format stream-json --output-format stream-json --verbose --session-id <uuid> ...
   ```
6. `--worktree` replaces the need for `cwd` — Claude Code creates the worktree directory and runs inside it.
7. `persistentSessions` map stores `worktreeName: string | null` on the session entry.

**Key decision:** Claude Code owns worktree creation via `--worktree`. Cogpit does not call `git worktree add` directly. Management actions (delete, cleanup) call git commands directly since those happen outside a Claude session.

## Sidebar Indicators

- **Branch badge** — Small pill/tag next to session name showing worktree name. Muted color, small font.
- **Status dot** — Green if worktree has uncommitted changes, gray if clean. Data comes from `/api/worktrees`.
- No new sidebar sections — just visual annotations on existing session cards.

## Worktree Management Panel

New panel accessible from top nav (alongside Teams, Stats).

### Worktree List

Table/card grid showing all worktrees for the current project. Each entry displays:
- Worktree name and branch
- Status: clean, dirty, or has commits ahead of main
- Associated session(s) — clickable to jump to session
- Age (relative time)
- HEAD commit short hash and message

### Actions Per Worktree

- **Open session** — Jump to linked session, or start a new session in that worktree
- **Create PR** — Pushes branch, runs `gh pr create`. Modal lets user edit title/description. Returns PR URL. Uses `gh` directly (no Claude session needed).
- **Delete** — `git worktree remove` + `git branch -d`. Confirmation dialog with warning if uncommitted changes or unpushed commits exist.

### Bulk Actions

- **Cleanup stale** — Finds worktrees with no changes, no active session, older than threshold (default 7 days). Lists for confirmation before deletion.
- **Refresh** — Re-fetches worktree data.

## Backend Routes

Four new endpoints, registered in both `server/api-plugin.ts` and `electron/server.ts`:

### `GET /api/worktrees/:dirName`

Returns all worktrees for a project. Resolves project path from `dirName`, runs `git worktree list --porcelain`, then per worktree runs `git status --porcelain` and `git log main..HEAD --oneline`. Cross-references with session metadata to attach linked session IDs.

### `POST /api/worktrees/:dirName/create-pr`

Body: `{ worktreeName, title?, body? }`. Resolves worktree path, runs `git push -u origin <branch>` then `gh pr create` inside the worktree directory. Returns PR URL.

### `DELETE /api/worktrees/:dirName/:worktreeName`

Runs `git worktree remove <path>` and `git branch -d worktree-<name>`. Requires `force: true` in body if worktree is dirty.

### `POST /api/worktrees/:dirName/cleanup`

Body: `{ maxAgeDays?: number }`. First call returns list of stale worktrees. Second call with `{ confirm: true, names: [...] }` performs removal.

## Data Types

```typescript
interface WorktreeInfo {
  name: string           // e.g. "fix-auth-token-refresh"
  path: string           // e.g. "/repo/.claude/worktrees/fix-auth-token-refresh"
  branch: string         // e.g. "worktree-fix-auth-token-refresh"
  head: string           // short SHA
  headMessage: string    // commit message
  isDirty: boolean       // has uncommitted changes
  commitsAhead: number   // commits ahead of main
  linkedSessions: string[] // session IDs derived from gitBranch match
  createdAt: string      // from directory mtime
}
```

## Frontend State Changes

- `useSessionState` reducer: new `worktreeName: string | null` field on pending session state.
- New hook `useWorktrees(dirName)`: fetches `/api/worktrees/:dirName`, polls every 30s, exposes list + loading/error.
- Session creation UI: local `useState` for toggle and name input.
- No new reducer actions beyond adding `worktreeName` to `INIT_PENDING_SESSION`.

## V2 Roadmap

Features explicitly deferred from v1:

- **Merge/rebase UI** — Merge worktree branch back into main from the management panel with conflict detection
- **Conflict resolution** — Visual merge conflict editor when merging worktree branches
- **Worktree diffing** — Side-by-side diff view comparing changes between two worktrees
- **Worktree-to-worktree comparison** — Compare the state of code across parallel worktrees
- **Auto-worktree by default** — Option to make worktree the default for all new sessions (not just per-project opt-in)
- **Worktree templates** — Pre-configured worktree setups for common workflows (e.g. "bugfix", "feature", "spike")
- **Cross-worktree cherry-pick** — Pick specific commits from one worktree into another
