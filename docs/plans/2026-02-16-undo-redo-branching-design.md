# Undo/Redo with Session Branching

## Overview

A time-travel system for Agent Window that lets users undo and redo agent turns, reverting or re-applying file changes on disk. When a user writes a new prompt after undoing, the old future turns are archived as a "branch" that can be revisited and restored later through a modal viewer.

## Core Concepts

### Reversible Operations

- **Edit**: swap `old_string` and `new_string` to reverse. Re-apply normally to redo.
- **Write**: delete the created file to undo. Re-create from JSONL `content` to redo.

### Undo State

Stored in a dedicated directory, one JSON file per session:

```
~/.claude/agent-window/undo-history/{session-id}.json
```

### Branching

When a user writes a new prompt after undoing turns, the undone turns are archived as a branch. Multiple branches can diverge from the same turn. Branches store full turn data (messages, thinking, tool calls) plus raw JSONL lines.

## Data Model

```typescript
interface UndoState {
  sessionId: string
  currentTurnIndex: number
  totalTurns: number
  branches: Branch[]
  activeBranchId: string | null
}

interface Branch {
  id: string
  createdAt: string
  branchPointTurnIndex: number
  label: string
  turns: ArchivedTurn[]
  jsonlLines: string[]
}

interface ArchivedTurn {
  index: number
  userMessage: string | null
  toolCalls: ArchivedToolCall[]
  thinkingBlocks: string[]
  assistantText: string[]
}

interface ArchivedToolCall {
  type: "Edit" | "Write"
  filePath: string
  oldString?: string
  newString?: string
  content?: string
}
```

## Operations

### Undo (Restore to Turn N)

1. User triggers via hover button or right-click context menu on a turn.
2. Confirmation dialog: "Undo X turns? This will revert changes to Y files."
3. Walk backwards from last turn to N+1:
   - Edit: apply with old_string/new_string swapped
   - Write: delete the file
4. Update `currentTurnIndex` in undo state file.
5. Turns N+1 through end are dimmed in the UI.
6. Floating redo bar appears at the bottom.

### Redo (Restore Forward to Turn M)

1. User clicks redo (next turn or specific dimmed turn).
2. Walk forward from current turn to M:
   - Edit: apply normally
   - Write: re-create from JSONL content
3. Update `currentTurnIndex`.
4. Restored turns become active again.

### Branching (New Prompt After Undo)

1. User is at turn 5, turns 6-12 are dimmed.
2. User writes a new prompt.
3. Archive turns 6-12 as a new Branch (full data + raw JSONL lines).
4. Remove those lines from the session JSONL file.
5. Clear redo state.
6. New prompt continues as turn 6.
7. Branch indicator appears on turn 5.

### Cross-Branch Switch (From Modal)

1. User clicks branch indicator, modal opens.
2. Browses a branch, clicks "Redo to here" on a turn.
3. If currently past the branch point: undo back to that point first.
4. Apply the selected branch's operations from start to target turn.
5. Current active turns after branch point (if any) archived as new branch first.

## UI Components

### Main Chat (No-Branch Undo/Redo)

- **Turn header hover button**: subtle "Restore to here" icon on each turn.
- **Right-click context menu**: "Restore to this point" option.
- **Dimmed undone turns**: `opacity-40`, dashed left border, "undone" badge.
- **Floating redo bar**:
  ```
  ┌─────────────────────────────────────────────────┐
  │  ↩ 7 turns undone    [Redo Next] [Redo All]     │
  └─────────────────────────────────────────────────┘
  ```

### Branch Indicator

- Turns with branches show a fork icon + count badge: `Turn 5 ⑂ 2`
- Click opens the branch modal.

### Branch Modal

- Large modal showing full branch content (turns after branch point only).
- Chat-like interface with user messages, thinking, assistant text, tool calls.
- Arrow buttons + keyboard left/right to switch between branches from same point.
- "Redo to here" button on each turn.
- "Redo entire branch" button at the bottom.
- Confirmation dialog before any redo.

### Confirmation Dialog

- Shows before all undo/redo/switch operations.
- Lists number of turns affected and files that will change.

## Safety & Edge Cases

### Conflict Detection

- Before undoing an Edit, verify `new_string` exists in the file.
- Before deleting a Write file, verify content matches.
- On conflict: show error toast, abort entire operation (no partial reverts).

### Partial Failure Rollback

- Maintain a rollback stack during operations.
- If any step fails, walk back all previously applied steps.

### Branch Limits

- Cap at 20 branches per session. Warning at 15.

### No Keyboard Shortcuts for Undo/Redo

- Arrow keys only active inside the branch modal (navigate branches).
- All undo/redo is explicit via UI clicks.

## Technical Architecture

### New Files

```
src/lib/undo-engine.ts           # Core undo/redo/branch logic
src/hooks/useUndoRedo.ts         # React hook wrapping the engine
src/components/UndoRedoBar.tsx    # Floating redo bar
src/components/BranchIndicator.tsx # Fork icon + count badge
src/components/BranchModal.tsx    # Full branch viewer modal
src/components/TurnContextMenu.tsx # Right-click menu
src/components/UndoConfirmDialog.tsx # Confirmation dialog
```

### Modified Files

```
src/lib/types.ts                        # Add UndoState, Branch, ArchivedTurn types
src/hooks/useSessionState.ts            # New actions: UNDO, REDO, BRANCH, SET_UNDO_STATE
src/components/ConversationTimeline.tsx  # Hover button, context menu, dimming
src/App.tsx                             # Wire useUndoRedo hook
server/api-plugin.ts                    # New endpoints for undo state + file ops
```

### Server Endpoints

```
GET  /api/undo-state/:sessionId          # Read undo state
POST /api/undo-state/:sessionId          # Save undo state
POST /api/undo/apply-edit                # Apply an edit (normal or reversed)
POST /api/undo/delete-file               # Delete a file (undo Write)
POST /api/undo/write-file                # Write a file (redo Write)
POST /api/undo/verify-file               # Verify file content before operation
PATCH /api/sessions/:dir/:file           # Truncate JSONL lines on branch
```
