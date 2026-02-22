# Worktree Management V2 — Sheet Panel & File Changes

## Overview

Redesign the WorktreePanel from a fixed sidebar into a slide-over sheet, add per-worktree file change previews, and fix the bug where worktree sessions can't see the worktree list.

## Sheet Component

- Built on `@radix-ui/react-dialog` (same primitive as existing Dialog component)
- Slides in from right edge, portal-rendered overlay
- `max-w-[560px] w-full`, backdrop `bg-black/40 backdrop-blur-[2px]`
- Dismissible via backdrop click or Escape
- Animate: `slide-in-from-right` on open, `slide-out-to-right` on close
- Replaces the current inline sidebar — WorktreePanel is no longer part of the flex layout

## Worktree Card Redesign

Each card shows:
- Name, dirty indicator (amber dot), commits-ahead badge
- Short commit hash + message, relative age
- Expandable file changes accordion: click "N files changed (+A -D)" to reveal per-file stats
- File status color-coded: M=yellow, A=green, D=red
- Action buttons: Open Session, Create PR, Delete

## File Changes Data

New `changedFiles` field on `WorktreeInfo`:

```typescript
interface FileChange {
  path: string
  status: "M" | "A" | "D" | "R"
  additions: number
  deletions: number
}
```

Backend collects via read-only git commands:
- `git diff --numstat` for uncommitted changes
- `git diff --numstat <default-branch>..HEAD` for committed changes
- No writes to git history

## Bug Fix — Worktree Path Normalization

**Problem:** When viewing a worktree session, `resolveProjectPath` returns the worktree directory. `getGitRoot` (`--show-toplevel`) returns the worktree root, not the main repo root. Session-linking reads the wrong JSONL directory.

**Fix:** Replace `getGitRoot` with `getMainWorktreeRoot` using `git rev-parse --git-common-dir`, which always resolves to the main repo's `.git` directory. Its parent is the main repo root.

```typescript
function getMainWorktreeRoot(projectPath: string): string | null {
  const commonDir = execSync("git rev-parse --git-common-dir", { cwd: projectPath })
  return path.dirname(path.resolve(projectPath, commonDir.trim()))
}
```

## Files Changed

- **New:** `src/components/ui/sheet.tsx`
- **Modified:** `server/routes/worktrees.ts`, `server/helpers.ts`, `src/components/WorktreePanel.tsx`, `src/App.tsx`
- **Unchanged:** `DesktopHeader.tsx`, `useWorktrees.ts`, session creation flow, sidebar badges, route registration

## Safety

- All git commands are read-only (`rev-parse`, `diff --numstat`, `worktree list`)
- No writes to git history
- No changes to git refs, branches, or worktree state
- Existing delete/PR/cleanup actions unchanged
