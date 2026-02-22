# Worktree Slide-Over Panel — Phase 2 Design

## Problem

The V1 worktree panel is a fixed-width sidebar (`w-72`) that takes permanent layout space when open. It shows minimal information per worktree (dirty flag, commits ahead, commit message) and has a path resolution bug that prevents it from working when viewing a worktree session.

## Solution

Convert the worktree panel to a slide-over sheet (560px) with richer worktree cards featuring collapsible file change previews.

## Design Decisions

1. **Sheet/drawer overlay** — Slides from right edge, has backdrop dimmer (`bg-black/40`), dismissible by clicking outside or pressing Escape. Chosen over collapsible sidebar (too disruptive to chat layout) and floating panel (too easy to lose).

2. **Medium width (560px)** — Enough room for file change lists without feeling cramped. Still clearly a "panel" not a "page".

3. **File changes preview** — Each worktree card has a collapsible accordion showing `git diff --stat` output: file path, status letter (M/A/D/R, color-coded), +additions/-deletions. Lightweight stats only, no actual diff content.

4. **Path normalization fix** — Use `git rev-parse --git-common-dir` to resolve from any worktree back to the main repository root, fixing the bug where the panel shows empty when inside a worktree session.

## Card Layout

```
┌─────────────────────────────────────────────┐
│ fix-auth-token  ●amber  [3 ahead]           │
│ abc1234 · fix auth token refresh logic       │
│ 2 hours ago                                  │
│                                              │
│ ▶ 4 files changed  (+32 -8)                 │
│                                              │
│                    [Open] [PR] [Delete]       │
└─────────────────────────────────────────────┘
```

Expanded accordion:
```
▼ 4 files changed  (+32 -8)
  M src/auth/token.ts        +18  -3
  A src/auth/types.ts         +4  -0
  D src/auth/legacy.ts        -3
```

## Technical Approach

- Sheet component built on `@radix-ui/react-dialog` (same primitive as Dialog)
- Backend adds `changedFiles: WorktreeFileChange[]` to `WorktreeInfo` via `git diff --numstat`
- `getGitRoot()` fixed with `git rev-parse --git-common-dir` for worktree path normalization
- Collapsible accordion uses existing `Collapsible` Radix primitive
- Scroll area with fade gradients follows `FileChangesPanel.tsx` pattern
