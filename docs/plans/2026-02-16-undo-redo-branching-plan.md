# Undo/Redo with Session Branching — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add time-travel undo/redo to Agent Window that reverts/re-applies file changes per turn, with git-like branching when the user writes a new prompt after undoing.

**Architecture:** Reversible operations engine (swap Edit old/new strings, delete/recreate Write files) backed by a sidecar JSON state file per session. Server-side API handles all file mutations. UI adds hover restore buttons, right-click context menu, dimmed undone turns, floating redo bar, branch indicators, and a full-screen branch viewer modal.

**Tech Stack:** React 19, TypeScript, Vite, Radix UI (Dialog for modal, ContextMenu for right-click), Lucide icons, TailwindCSS 4.

---

## Phase 1: Foundation — Types & Undo Engine

### Task 1.1: Add Undo/Branch Types

**Files:**
- Modify: `src/lib/types.ts` (append after line 192)

**Step 1: Add the undo/branch type definitions**

Append to the end of `src/lib/types.ts`:

```typescript
// ── Undo/Redo & Branching ────────────────────────────────────────────────

export interface ArchivedToolCall {
  type: "Edit" | "Write"
  filePath: string
  oldString?: string   // Edit only
  newString?: string   // Edit only
  content?: string     // Write only
}

export interface ArchivedTurn {
  index: number
  userMessage: string | null
  toolCalls: ArchivedToolCall[]
  thinkingBlocks: string[]
  assistantText: string[]
  timestamp: string
  model: string | null
}

export interface Branch {
  id: string
  createdAt: string
  branchPointTurnIndex: number
  label: string
  turns: ArchivedTurn[]
  jsonlLines: string[]
}

export interface UndoState {
  sessionId: string
  currentTurnIndex: number
  totalTurns: number
  branches: Branch[]
  activeBranchId: string | null
}
```

**Step 2: Verify it compiles**

Run: `cd /Users/gentritbiba/.claude/agent-window && bunx tsc --noEmit`
Expected: No errors.

**Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat(undo): add UndoState, Branch, ArchivedTurn types"
```

---

### Task 1.2: Create the Undo Engine

**Files:**
- Create: `src/lib/undo-engine.ts`

This is the pure-logic module with no React dependencies. It handles:
- Extracting reversible tool calls from turns
- Building undo/redo operation lists
- Archiving turns into branches
- Conflict detection helpers

**Step 1: Create `src/lib/undo-engine.ts`**

```typescript
import type { Turn, ArchivedTurn, ArchivedToolCall, Branch, UndoState } from "./types"
import { getUserMessageText } from "./parser"

// ── Extract reversible tool calls from a Turn ────────────────────────────

export function extractReversibleCalls(turn: Turn): ArchivedToolCall[] {
  const calls: ArchivedToolCall[] = []
  for (const tc of turn.toolCalls) {
    if (tc.isError) continue // skip failed tool calls
    if (tc.name === "Edit") {
      const oldStr = tc.input.old_string as string | undefined
      const newStr = tc.input.new_string as string | undefined
      const filePath = (tc.input.file_path ?? tc.input.path ?? "") as string
      if (oldStr !== undefined && newStr !== undefined && filePath) {
        calls.push({ type: "Edit", filePath, oldString: oldStr, newString: newStr })
      }
    } else if (tc.name === "Write") {
      const filePath = (tc.input.file_path ?? tc.input.path ?? "") as string
      const content = tc.input.content as string | undefined
      if (filePath && content !== undefined) {
        calls.push({ type: "Write", filePath, content })
      }
    }
  }
  return calls
}

// ── Archive a Turn into a storable format ────────────────────────────────

export function archiveTurn(turn: Turn, index: number): ArchivedTurn {
  return {
    index,
    userMessage: getUserMessageText(turn.userMessage),
    toolCalls: extractReversibleCalls(turn),
    thinkingBlocks: turn.thinking.map((t) => t.thinking),
    assistantText: [...turn.assistantText],
    timestamp: turn.timestamp,
    model: turn.model,
  }
}

// ── Build the list of file operations for undo (reverse order) ───────────

export interface FileOperation {
  type: "reverse-edit" | "delete-write" | "apply-edit" | "create-write"
  filePath: string
  oldString?: string
  newString?: string
  content?: string
  turnIndex: number
}

export function buildUndoOperations(
  turns: Turn[],
  fromTurnIndex: number, // current position (inclusive)
  toTurnIndex: number    // target position (inclusive, we keep this turn)
): FileOperation[] {
  const ops: FileOperation[] = []
  // Walk backwards from fromTurnIndex to toTurnIndex + 1
  for (let i = fromTurnIndex; i > toTurnIndex; i--) {
    const turn = turns[i]
    if (!turn) continue
    const calls = extractReversibleCalls(turn)
    // Reverse within the turn too (last call first)
    for (let j = calls.length - 1; j >= 0; j--) {
      const call = calls[j]
      if (call.type === "Edit") {
        ops.push({
          type: "reverse-edit",
          filePath: call.filePath,
          // Swap: to undo, the "old" becomes what we write, "new" becomes what we find
          oldString: call.newString,
          newString: call.oldString,
          turnIndex: i,
        })
      } else if (call.type === "Write") {
        ops.push({
          type: "delete-write",
          filePath: call.filePath,
          content: call.content, // stored for verification
          turnIndex: i,
        })
      }
    }
  }
  return ops
}

// ── Build the list of file operations for redo (forward order) ───────────

export function buildRedoOperations(
  turns: Turn[],
  fromTurnIndex: number, // current position (inclusive, already applied)
  toTurnIndex: number    // target position (inclusive)
): FileOperation[] {
  const ops: FileOperation[] = []
  // Walk forward from fromTurnIndex + 1 to toTurnIndex
  for (let i = fromTurnIndex + 1; i <= toTurnIndex; i++) {
    const turn = turns[i]
    if (!turn) continue
    const calls = extractReversibleCalls(turn)
    for (const call of calls) {
      if (call.type === "Edit") {
        ops.push({
          type: "apply-edit",
          filePath: call.filePath,
          oldString: call.oldString,
          newString: call.newString,
          turnIndex: i,
        })
      } else if (call.type === "Write") {
        ops.push({
          type: "create-write",
          filePath: call.filePath,
          content: call.content,
          turnIndex: i,
        })
      }
    }
  }
  return ops
}

// ── Build redo operations from archived turns (branch restore) ───────────

export function buildRedoFromArchived(
  archivedTurns: ArchivedTurn[],
  upToIndex?: number // optional: only redo up to this archived turn index
): FileOperation[] {
  const ops: FileOperation[] = []
  const limit = upToIndex !== undefined ? upToIndex + 1 : archivedTurns.length
  for (let i = 0; i < limit; i++) {
    const at = archivedTurns[i]
    for (const call of at.toolCalls) {
      if (call.type === "Edit") {
        ops.push({
          type: "apply-edit",
          filePath: call.filePath,
          oldString: call.oldString,
          newString: call.newString,
          turnIndex: at.index,
        })
      } else if (call.type === "Write") {
        ops.push({
          type: "create-write",
          filePath: call.filePath,
          content: call.content,
          turnIndex: at.index,
        })
      }
    }
  }
  return ops
}

// ── Create a new branch from undone turns ────────────────────────────────

export function createBranch(
  turns: Turn[],
  branchPointTurnIndex: number,
  jsonlLines: string[]
): Branch {
  const archivedTurns: ArchivedTurn[] = []
  for (let i = branchPointTurnIndex + 1; i < turns.length; i++) {
    archivedTurns.push(archiveTurn(turns[i], i))
  }

  const firstPrompt = archivedTurns[0]?.userMessage || "Untitled branch"
  const label = firstPrompt.length > 60 ? firstPrompt.slice(0, 57) + "..." : firstPrompt

  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    branchPointTurnIndex,
    label,
    turns: archivedTurns,
    jsonlLines,
  }
}

// ── Compute summary for confirmation dialog ──────────────────────────────

export interface OperationSummary {
  turnCount: number
  fileCount: number
  filePaths: string[]
  operationCount: number
}

export function summarizeOperations(ops: FileOperation[]): OperationSummary {
  const files = new Set<string>()
  const turns = new Set<number>()
  for (const op of ops) {
    files.add(op.filePath)
    turns.add(op.turnIndex)
  }
  return {
    turnCount: turns.size,
    fileCount: files.size,
    filePaths: [...files],
    operationCount: ops.length,
  }
}

// ── Create empty undo state ──────────────────────────────────────────────

export function createEmptyUndoState(sessionId: string, totalTurns: number): UndoState {
  return {
    sessionId,
    currentTurnIndex: totalTurns - 1,
    totalTurns,
    branches: [],
    activeBranchId: null,
  }
}
```

**Step 2: Verify it compiles**

Run: `cd /Users/gentritbiba/.claude/agent-window && bunx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/lib/undo-engine.ts
git commit -m "feat(undo): create undo engine with reversible operations"
```

---

### Task 1.3: Add Server API Endpoints

**Files:**
- Modify: `server/api-plugin.ts` (add new routes before the closing of `configureServer`)

Add these endpoints inside the `configureServer(server)` block, before the final `// GET /api/watch/` route (around line 1420):

**Step 1: Add imports and undo state directory constant**

At the top of `server/api-plugin.ts`, after line 7 (`import { homedir } from "node:os"`), add:

```typescript
import { mkdir, unlink, access } from "node:fs/promises"
```

After line 11 (`const TASKS_DIR = ...`), add:

```typescript
const UNDO_DIR = join(homedir(), ".claude", "agent-window", "undo-history")
```

**Step 2: Add the undo API routes**

Insert before the `// GET /api/watch/` SSE route (line 1420). These endpoints:

```typescript
      // ── Undo/Redo API Endpoints ──────────────────────────────────────────

      // GET /api/undo-state/:sessionId - read undo state
      server.middlewares.use("/api/undo-state/", async (req, res, next) => {
        if (req.method !== "GET" && req.method !== "POST") return next()

        const url = new URL(req.url || "/", "http://localhost")
        const parts = url.pathname.split("/").filter(Boolean)
        if (parts.length !== 1) return next()

        const sessionId = decodeURIComponent(parts[0])
        const filePath = join(UNDO_DIR, `${sessionId}.json`)

        if (req.method === "GET") {
          try {
            const content = await readFile(filePath, "utf-8")
            res.setHeader("Content-Type", "application/json")
            res.end(content)
          } catch {
            res.statusCode = 404
            res.end(JSON.stringify({ error: "No undo state" }))
          }
          return
        }

        // POST - save undo state
        let body = ""
        req.on("data", (chunk: string) => { body += chunk })
        req.on("end", async () => {
          try {
            await mkdir(UNDO_DIR, { recursive: true })
            await writeFile(filePath, body, "utf-8")
            res.setHeader("Content-Type", "application/json")
            res.end(JSON.stringify({ success: true }))
          } catch (err) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: String(err) }))
          }
        })
      })

      // POST /api/undo/apply - apply a batch of file operations (undo or redo)
      server.middlewares.use("/api/undo/apply", (req, res, next) => {
        if (req.method !== "POST") return next()

        let body = ""
        req.on("data", (chunk: string) => { body += chunk })
        req.on("end", async () => {
          try {
            const { operations } = JSON.parse(body) as {
              operations: Array<{
                type: "reverse-edit" | "delete-write" | "apply-edit" | "create-write"
                filePath: string
                oldString?: string
                newString?: string
                content?: string
              }>
            }

            if (!Array.isArray(operations) || operations.length === 0) {
              res.statusCode = 400
              res.end(JSON.stringify({ error: "operations array required" }))
              return
            }

            // Track applied operations for rollback
            const applied: Array<{
              type: string
              filePath: string
              previousContent?: string
              fileExisted: boolean
            }> = []

            try {
              for (const op of operations) {
                if (op.type === "reverse-edit" || op.type === "apply-edit") {
                  // Read current file content
                  const content = await readFile(op.filePath, "utf-8")

                  // Verify the string we expect to find actually exists
                  if (op.oldString && !content.includes(op.oldString)) {
                    throw new Error(
                      `Conflict: expected string not found in ${op.filePath}. File may have been modified externally.`
                    )
                  }

                  // Apply the edit
                  const updated = content.replace(op.oldString!, op.newString!)
                  applied.push({ type: op.type, filePath: op.filePath, previousContent: content, fileExisted: true })
                  await writeFile(op.filePath, updated, "utf-8")

                } else if (op.type === "delete-write") {
                  // Verify file content matches before deleting
                  let fileExisted = true
                  try {
                    const content = await readFile(op.filePath, "utf-8")
                    // Optional: verify content matches if provided
                    applied.push({ type: op.type, filePath: op.filePath, previousContent: content, fileExisted: true })
                  } catch {
                    fileExisted = false
                    applied.push({ type: op.type, filePath: op.filePath, fileExisted: false })
                  }
                  if (fileExisted) {
                    await unlink(op.filePath)
                  }

                } else if (op.type === "create-write") {
                  // Check if file already exists
                  let fileExisted = false
                  let previousContent: string | undefined
                  try {
                    previousContent = await readFile(op.filePath, "utf-8")
                    fileExisted = true
                  } catch {
                    fileExisted = false
                  }
                  applied.push({ type: op.type, filePath: op.filePath, previousContent, fileExisted })
                  await writeFile(op.filePath, op.content!, "utf-8")
                }
              }

              res.setHeader("Content-Type", "application/json")
              res.end(JSON.stringify({ success: true, applied: applied.length }))

            } catch (err) {
              // Rollback all applied operations
              for (let i = applied.length - 1; i >= 0; i--) {
                const a = applied[i]
                try {
                  if (a.type === "reverse-edit" || a.type === "apply-edit") {
                    // Restore previous content
                    if (a.previousContent !== undefined) {
                      await writeFile(a.filePath, a.previousContent, "utf-8")
                    }
                  } else if (a.type === "delete-write") {
                    // Recreate the deleted file
                    if (a.previousContent !== undefined) {
                      await writeFile(a.filePath, a.previousContent, "utf-8")
                    }
                  } else if (a.type === "create-write") {
                    // Delete the created file or restore previous
                    if (a.fileExisted && a.previousContent !== undefined) {
                      await writeFile(a.filePath, a.previousContent, "utf-8")
                    } else if (!a.fileExisted) {
                      try { await unlink(a.filePath) } catch { /* file may not exist */ }
                    }
                  }
                } catch {
                  // Best-effort rollback
                }
              }

              res.statusCode = 409
              res.end(JSON.stringify({
                error: String(err instanceof Error ? err.message : err),
                rolledBack: applied.length,
              }))
            }
          } catch {
            res.statusCode = 400
            res.end(JSON.stringify({ error: "Invalid JSON body" }))
          }
        })
      })

      // PATCH /api/undo/truncate-jsonl - remove lines from a JSONL file (for branching)
      server.middlewares.use("/api/undo/truncate-jsonl", (req, res, next) => {
        if (req.method !== "POST") return next()

        let body = ""
        req.on("data", (chunk: string) => { body += chunk })
        req.on("end", async () => {
          try {
            const { dirName, fileName, keepLines } = JSON.parse(body) as {
              dirName: string
              fileName: string
              keepLines: number
            }

            const filePath = join(PROJECTS_DIR, dirName, fileName)
            if (!isWithinDir(PROJECTS_DIR, filePath)) {
              res.statusCode = 403
              res.end(JSON.stringify({ error: "Access denied" }))
              return
            }

            const content = await readFile(filePath, "utf-8")
            const lines = content.split("\n").filter(Boolean)

            if (keepLines >= lines.length) {
              res.setHeader("Content-Type", "application/json")
              res.end(JSON.stringify({ success: true, removedLines: [] }))
              return
            }

            const removedLines = lines.slice(keepLines)
            const keptContent = lines.slice(0, keepLines).join("\n") + "\n"
            await writeFile(filePath, keptContent, "utf-8")

            res.setHeader("Content-Type", "application/json")
            res.end(JSON.stringify({ success: true, removedLines }))
          } catch (err) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: String(err) }))
          }
        })
      })
```

**Step 3: Verify it compiles**

Run: `cd /Users/gentritbiba/.claude/agent-window && bunx tsc --noEmit`

**Step 4: Commit**

```bash
git add server/api-plugin.ts
git commit -m "feat(undo): add server endpoints for undo state, file ops, and JSONL truncation"
```

---

## Phase 2: React Hook & State Management

### Task 2.1: Create the useUndoRedo Hook

**Files:**
- Create: `src/hooks/useUndoRedo.ts`

This hook manages:
- Loading/saving undo state from server
- Triggering undo/redo operations
- Branch creation and switching
- Confirmation dialog state

**Step 1: Create `src/hooks/useUndoRedo.ts`**

```typescript
import { useState, useCallback, useRef, useEffect } from "react"
import type { ParsedSession, UndoState, Branch } from "@/lib/types"
import type { SessionSource } from "./useLiveSession"
import {
  buildUndoOperations,
  buildRedoOperations,
  buildRedoFromArchived,
  summarizeOperations,
  createBranch,
  createEmptyUndoState,
  type FileOperation,
  type OperationSummary,
} from "@/lib/undo-engine"

export interface UndoConfirmState {
  type: "undo" | "redo" | "branch-switch"
  summary: OperationSummary
  targetTurnIndex: number
  branchId?: string
  branchTurnIndex?: number // for branch-switch: which archived turn to redo to
}

export interface UseUndoRedoResult {
  undoState: UndoState | null
  isUndone: boolean
  undoableTurnCount: number
  branches: Branch[]
  branchesAtTurn: (turnIndex: number) => Branch[]

  // Actions
  requestUndo: (targetTurnIndex: number) => void
  requestRedoNext: () => void
  requestRedoAll: () => void
  requestRedoToTurn: (targetTurnIndex: number) => void
  requestBranchSwitch: (branchId: string, archiveTurnIndex?: number) => void

  // Confirmation dialog
  confirmState: UndoConfirmState | null
  confirmApply: () => Promise<void>
  confirmCancel: () => void

  // Loading
  isApplying: boolean
  applyError: string | null
}

export function useUndoRedo(
  session: ParsedSession | null,
  sessionSource: SessionSource | null,
  onSessionUpdate: (updated: ParsedSession) => void,
): UseUndoRedoResult {
  const [undoState, setUndoState] = useState<UndoState | null>(null)
  const [confirmState, setConfirmState] = useState<UndoConfirmState | null>(null)
  const [isApplying, setIsApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const sessionIdRef = useRef<string | null>(null)

  // Load undo state when session changes
  useEffect(() => {
    if (!session) {
      setUndoState(null)
      sessionIdRef.current = null
      return
    }
    if (session.sessionId === sessionIdRef.current) return
    sessionIdRef.current = session.sessionId

    fetch(`/api/undo-state/${encodeURIComponent(session.sessionId)}`)
      .then((res) => res.ok ? res.json() : null)
      .then((data: UndoState | null) => {
        if (data) {
          // Update totalTurns to reflect current session
          setUndoState({ ...data, totalTurns: session.turns.length })
        } else {
          setUndoState(null)
        }
      })
      .catch(() => setUndoState(null))
  }, [session?.sessionId, session?.turns.length])

  // Save undo state to server
  const saveUndoState = useCallback(async (state: UndoState) => {
    setUndoState(state)
    try {
      await fetch(`/api/undo-state/${encodeURIComponent(state.sessionId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state),
      })
    } catch (err) {
      console.error("Failed to save undo state:", err)
    }
  }, [])

  // Apply file operations via server
  const applyOperations = useCallback(async (operations: FileOperation[]): Promise<boolean> => {
    setIsApplying(true)
    setApplyError(null)
    try {
      const res = await fetch("/api/undo/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operations }),
      })
      const data = await res.json()
      if (!res.ok) {
        setApplyError(data.error || "Operation failed")
        return false
      }
      return true
    } catch (err) {
      setApplyError(String(err))
      return false
    } finally {
      setIsApplying(false)
    }
  }, [])

  const isUndone = undoState !== null && undoState.currentTurnIndex < undoState.totalTurns - 1
  const undoableTurnCount = undoState
    ? undoState.totalTurns - 1 - undoState.currentTurnIndex
    : 0

  const branches = undoState?.branches ?? []

  const branchesAtTurn = useCallback((turnIndex: number) => {
    return branches.filter((b) => b.branchPointTurnIndex === turnIndex)
  }, [branches])

  // Request undo — shows confirmation
  const requestUndo = useCallback((targetTurnIndex: number) => {
    if (!session) return
    const currentIdx = undoState?.currentTurnIndex ?? session.turns.length - 1
    if (targetTurnIndex >= currentIdx) return

    const ops = buildUndoOperations(session.turns, currentIdx, targetTurnIndex)
    if (ops.length === 0) {
      // No file operations to revert, just update state
      const newState = undoState
        ? { ...undoState, currentTurnIndex: targetTurnIndex }
        : createEmptyUndoState(session.sessionId, session.turns.length)
      newState.currentTurnIndex = targetTurnIndex
      saveUndoState(newState)
      return
    }

    setConfirmState({
      type: "undo",
      summary: summarizeOperations(ops),
      targetTurnIndex,
    })
  }, [session, undoState, saveUndoState])

  // Request redo
  const requestRedoToTurn = useCallback((targetTurnIndex: number) => {
    if (!session) return
    const currentIdx = undoState?.currentTurnIndex ?? session.turns.length - 1
    if (targetTurnIndex <= currentIdx) return

    const ops = buildRedoOperations(session.turns, currentIdx, targetTurnIndex)
    if (ops.length === 0) {
      const newState = undoState
        ? { ...undoState, currentTurnIndex: targetTurnIndex }
        : createEmptyUndoState(session.sessionId, session.turns.length)
      newState.currentTurnIndex = targetTurnIndex
      saveUndoState(newState)
      return
    }

    setConfirmState({
      type: "redo",
      summary: summarizeOperations(ops),
      targetTurnIndex,
    })
  }, [session, undoState, saveUndoState])

  const requestRedoNext = useCallback(() => {
    if (!undoState || !session) return
    const next = Math.min(undoState.currentTurnIndex + 1, undoState.totalTurns - 1)
    requestRedoToTurn(next)
  }, [undoState, session, requestRedoToTurn])

  const requestRedoAll = useCallback(() => {
    if (!undoState || !session) return
    requestRedoToTurn(undoState.totalTurns - 1)
  }, [undoState, session, requestRedoToTurn])

  // Request branch switch
  const requestBranchSwitch = useCallback((branchId: string, archiveTurnIndex?: number) => {
    if (!session || !undoState) return
    const branch = branches.find((b) => b.id === branchId)
    if (!branch) return

    const targetArchiveIdx = archiveTurnIndex ?? branch.turns.length - 1
    const ops = buildRedoFromArchived(branch.turns, targetArchiveIdx)

    // If we're currently past the branch point, we need to undo first
    const currentIdx = undoState.currentTurnIndex
    let fullOps: FileOperation[] = []
    if (currentIdx > branch.branchPointTurnIndex) {
      const undoOps = buildUndoOperations(session.turns, currentIdx, branch.branchPointTurnIndex)
      fullOps = [...undoOps, ...ops]
    } else {
      fullOps = ops
    }

    if (fullOps.length === 0) return

    setConfirmState({
      type: "branch-switch",
      summary: summarizeOperations(fullOps),
      targetTurnIndex: branch.branchPointTurnIndex,
      branchId,
      branchTurnIndex: targetArchiveIdx,
    })
  }, [session, undoState, branches])

  // Confirm and apply the pending operation
  const confirmApply = useCallback(async () => {
    if (!confirmState || !session || !undoState && confirmState.type !== "undo") {
      setConfirmState(null)
      return
    }

    const state = undoState ?? createEmptyUndoState(session.sessionId, session.turns.length)
    const currentIdx = state.currentTurnIndex

    let ops: FileOperation[] = []

    if (confirmState.type === "undo") {
      ops = buildUndoOperations(session.turns, currentIdx, confirmState.targetTurnIndex)
    } else if (confirmState.type === "redo") {
      ops = buildRedoOperations(session.turns, currentIdx, confirmState.targetTurnIndex)
    } else if (confirmState.type === "branch-switch") {
      const branch = branches.find((b) => b.id === confirmState.branchId)
      if (!branch) { setConfirmState(null); return }

      // Undo to branch point if needed
      if (currentIdx > branch.branchPointTurnIndex) {
        const undoOps = buildUndoOperations(session.turns, currentIdx, branch.branchPointTurnIndex)
        const redoOps = buildRedoFromArchived(branch.turns, confirmState.branchTurnIndex)
        ops = [...undoOps, ...redoOps]
      } else {
        ops = buildRedoFromArchived(branch.turns, confirmState.branchTurnIndex)
      }
    }

    if (ops.length > 0) {
      const success = await applyOperations(ops)
      if (!success) return // keep dialog open on error
    }

    // Update state
    const newState = { ...state }

    if (confirmState.type === "undo" || confirmState.type === "redo") {
      newState.currentTurnIndex = confirmState.targetTurnIndex
    } else if (confirmState.type === "branch-switch") {
      newState.activeBranchId = confirmState.branchId!
      newState.currentTurnIndex = confirmState.targetTurnIndex
    }

    await saveUndoState(newState)
    setConfirmState(null)
  }, [confirmState, session, undoState, branches, applyOperations, saveUndoState])

  const confirmCancel = useCallback(() => {
    setConfirmState(null)
    setApplyError(null)
  }, [])

  return {
    undoState,
    isUndone,
    undoableTurnCount,
    branches,
    branchesAtTurn,
    requestUndo,
    requestRedoNext,
    requestRedoAll,
    requestRedoToTurn,
    requestBranchSwitch,
    confirmState,
    confirmApply,
    confirmCancel,
    isApplying,
    applyError,
  }
}
```

**Step 2: Verify it compiles**

Run: `cd /Users/gentritbiba/.claude/agent-window && bunx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/hooks/useUndoRedo.ts
git commit -m "feat(undo): create useUndoRedo hook with undo/redo/branch operations"
```

---

### Task 2.2: Extend Session State Reducer

**Files:**
- Modify: `src/hooks/useSessionState.ts`

**Step 1: Add undo-related actions to the reducer**

Add to the `SessionAction` type union (after line 38):

```typescript
  | { type: "SET_UNDO_TURN_INDEX"; index: number | null }
```

Add to `SessionState` interface (after line 19, the `mobileTab` line):

```typescript
  undoCurrentTurnIndex: number | null  // null = no undo active
```

Add to `initialState` (after line 53, the `mobileTab` line):

```typescript
  undoCurrentTurnIndex: null,
```

Add case to `sessionReducer` (before `default:`):

```typescript
    case "SET_UNDO_TURN_INDEX":
      return { ...state, undoCurrentTurnIndex: action.index }
```

Also, in the `LOAD_SESSION` case, reset undo: add `undoCurrentTurnIndex: null,` after the `expandAll: false,` line.

In the `GO_HOME` case, reset undo: add `undoCurrentTurnIndex: null,` after the `expandAll: false,` line.

**Step 2: Verify it compiles**

Run: `cd /Users/gentritbiba/.claude/agent-window && bunx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/hooks/useSessionState.ts
git commit -m "feat(undo): add undo turn index tracking to session state"
```

---

## Phase 3: Core UI Components

### Task 3.1: Create the Undo Confirmation Dialog

**Files:**
- Create: `src/components/UndoConfirmDialog.tsx`

Uses `@radix-ui/react-dialog` (already in package.json).

**Step 1: Create `src/components/UndoConfirmDialog.tsx`**

```typescript
import { AlertTriangle, Loader2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import type { UndoConfirmState } from "@/hooks/useUndoRedo"

interface UndoConfirmDialogProps {
  state: UndoConfirmState | null
  isApplying: boolean
  applyError: string | null
  onConfirm: () => void
  onCancel: () => void
}

const TITLES: Record<string, string> = {
  undo: "Undo turns?",
  redo: "Redo turns?",
  "branch-switch": "Switch branch?",
}

const DESCRIPTIONS: Record<string, string> = {
  undo: "This will revert file changes from the following turns.",
  redo: "This will re-apply file changes from the following turns.",
  "branch-switch": "This will switch to a different branch, undoing current changes and applying the branch's changes.",
}

export function UndoConfirmDialog({
  state,
  isApplying,
  applyError,
  onConfirm,
  onCancel,
}: UndoConfirmDialogProps) {
  if (!state) return null

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel() }}>
      <DialogContent className="sm:max-w-md bg-zinc-900 border-zinc-700">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-zinc-100">
            <AlertTriangle className="size-4 text-amber-400" />
            {TITLES[state.type]}
          </DialogTitle>
          <DialogDescription className="text-zinc-400">
            {DESCRIPTIONS[state.type]}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 py-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-zinc-500">Turns affected</span>
            <span className="text-zinc-200 font-mono">{state.summary.turnCount}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-zinc-500">Files affected</span>
            <span className="text-zinc-200 font-mono">{state.summary.fileCount}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-zinc-500">Operations</span>
            <span className="text-zinc-200 font-mono">{state.summary.operationCount}</span>
          </div>
          {state.summary.filePaths.length > 0 && (
            <div className="mt-2 max-h-32 overflow-y-auto rounded border border-zinc-800 bg-zinc-950 p-2">
              {state.summary.filePaths.map((fp) => (
                <div key={fp} className="text-[11px] font-mono text-zinc-400 truncate">
                  {fp}
                </div>
              ))}
            </div>
          )}
        </div>

        {applyError && (
          <div className="rounded border border-red-800 bg-red-900/20 px-3 py-2 text-sm text-red-400">
            {applyError}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button
            variant="ghost"
            onClick={onCancel}
            disabled={isApplying}
            className="text-zinc-400 hover:text-zinc-200"
          >
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={isApplying}
            className="bg-amber-600 hover:bg-amber-500 text-white"
          >
            {isApplying ? (
              <>
                <Loader2 className="size-4 animate-spin mr-2" />
                Applying...
              </>
            ) : (
              state.type === "undo" ? "Undo" : state.type === "redo" ? "Redo" : "Switch"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

**Step 2: Verify the Dialog UI component exists**

Check if `src/components/ui/dialog.tsx` exists. If not, we need to create it using the Radix Dialog primitive. The project already has `@radix-ui/react-dialog` in dependencies.

Run: `ls src/components/ui/dialog.tsx` — if it doesn't exist, create it using the standard shadcn/ui dialog template.

**Step 3: Verify it compiles**

Run: `cd /Users/gentritbiba/.claude/agent-window && bunx tsc --noEmit`

**Step 4: Commit**

```bash
git add src/components/UndoConfirmDialog.tsx src/components/ui/dialog.tsx
git commit -m "feat(undo): add confirmation dialog component"
```

---

### Task 3.2: Create the Turn Context Menu

**Files:**
- Create: `src/components/TurnContextMenu.tsx`

**Step 1: Install Radix context menu if needed**

Run: `cd /Users/gentritbiba/.claude/agent-window && bun add @radix-ui/react-context-menu`

**Step 2: Create `src/components/TurnContextMenu.tsx`**

```typescript
import * as ContextMenu from "@radix-ui/react-context-menu"
import { RotateCcw, GitFork } from "lucide-react"
import type { Branch } from "@/lib/types"

interface TurnContextMenuProps {
  children: React.ReactNode
  turnIndex: number
  isUndone: boolean
  canUndo: boolean
  canRedo: boolean
  branches: Branch[]
  onRestoreToHere: (turnIndex: number) => void
  onRedoToHere: (turnIndex: number) => void
  onOpenBranches: (turnIndex: number) => void
}

export function TurnContextMenu({
  children,
  turnIndex,
  isUndone,
  canUndo,
  canRedo,
  branches,
  onRestoreToHere,
  onRedoToHere,
  onOpenBranches,
}: TurnContextMenuProps) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="min-w-[180px] rounded-lg border border-zinc-700 bg-zinc-900 p-1 shadow-xl">
          {canUndo && !isUndone && (
            <ContextMenu.Item
              className="flex items-center gap-2 rounded px-2.5 py-1.5 text-sm text-zinc-300 outline-none cursor-pointer hover:bg-zinc-800 hover:text-zinc-100"
              onSelect={() => onRestoreToHere(turnIndex)}
            >
              <RotateCcw className="size-3.5" />
              Restore to this point
            </ContextMenu.Item>
          )}
          {isUndone && canRedo && (
            <ContextMenu.Item
              className="flex items-center gap-2 rounded px-2.5 py-1.5 text-sm text-zinc-300 outline-none cursor-pointer hover:bg-zinc-800 hover:text-zinc-100"
              onSelect={() => onRedoToHere(turnIndex)}
            >
              <RotateCcw className="size-3.5 scale-x-[-1]" />
              Redo to this point
            </ContextMenu.Item>
          )}
          {branches.length > 0 && (
            <>
              <ContextMenu.Separator className="my-1 h-px bg-zinc-800" />
              <ContextMenu.Item
                className="flex items-center gap-2 rounded px-2.5 py-1.5 text-sm text-zinc-300 outline-none cursor-pointer hover:bg-zinc-800 hover:text-zinc-100"
                onSelect={() => onOpenBranches(turnIndex)}
              >
                <GitFork className="size-3.5" />
                View branches ({branches.length})
              </ContextMenu.Item>
            </>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
```

**Step 3: Verify it compiles**

Run: `cd /Users/gentritbiba/.claude/agent-window && bunx tsc --noEmit`

**Step 4: Commit**

```bash
git add src/components/TurnContextMenu.tsx
git commit -m "feat(undo): add right-click context menu for turns"
```

---

### Task 3.3: Create the Floating Undo/Redo Bar

**Files:**
- Create: `src/components/UndoRedoBar.tsx`

**Step 1: Create `src/components/UndoRedoBar.tsx`**

```typescript
import { RotateCcw, ChevronsRight, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"

interface UndoRedoBarProps {
  undoneCount: number
  onRedoNext: () => void
  onRedoAll: () => void
}

export function UndoRedoBar({ undoneCount, onRedoNext, onRedoAll }: UndoRedoBarProps) {
  if (undoneCount <= 0) return null

  return (
    <div className="sticky bottom-0 z-20 flex items-center justify-center px-4 py-2">
      <div className="flex items-center gap-3 rounded-full border border-zinc-700 bg-zinc-900/95 backdrop-blur-sm px-4 py-2 shadow-lg">
        <div className="flex items-center gap-1.5 text-sm text-zinc-400">
          <RotateCcw className="size-3.5 text-amber-400" />
          <span className="font-mono">{undoneCount}</span>
          <span>turn{undoneCount !== 1 ? "s" : ""} undone</span>
        </div>
        <div className="h-4 w-px bg-zinc-700" />
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs text-zinc-300 hover:text-zinc-100 gap-1"
          onClick={onRedoNext}
        >
          <ChevronRight className="size-3.5" />
          Redo Next
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs text-blue-400 hover:text-blue-300 gap-1"
          onClick={onRedoAll}
        >
          <ChevronsRight className="size-3.5" />
          Redo All
        </Button>
      </div>
    </div>
  )
}
```

**Step 2: Verify it compiles**

Run: `cd /Users/gentritbiba/.claude/agent-window && bunx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/components/UndoRedoBar.tsx
git commit -m "feat(undo): add floating undo/redo bar component"
```

---

### Task 3.4: Create the Branch Indicator

**Files:**
- Create: `src/components/BranchIndicator.tsx`

**Step 1: Create `src/components/BranchIndicator.tsx`**

```typescript
import { GitFork } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"

interface BranchIndicatorProps {
  branchCount: number
  onClick: () => void
}

export function BranchIndicator({ branchCount, onClick }: BranchIndicatorProps) {
  if (branchCount === 0) return null

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={(e) => { e.stopPropagation(); onClick() }}
          className="inline-flex items-center gap-1 rounded-full border border-purple-800/50 bg-purple-500/10 px-1.5 py-0.5 text-purple-400 hover:bg-purple-500/20 hover:text-purple-300 transition-colors"
        >
          <GitFork className="size-3" />
          <span className="text-[10px] font-mono">{branchCount}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {branchCount} branch{branchCount !== 1 ? "es" : ""} from this turn
      </TooltipContent>
    </Tooltip>
  )
}
```

**Step 2: Verify it compiles**

Run: `cd /Users/gentritbiba/.claude/agent-window && bunx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/components/BranchIndicator.tsx
git commit -m "feat(undo): add branch indicator badge component"
```

---

### Task 3.5: Create the Branch Modal

**Files:**
- Create: `src/components/BranchModal.tsx`

This is the large modal that shows full branch content with navigation between branches and "Redo to here" on each turn.

**Step 1: Create `src/components/BranchModal.tsx`**

```typescript
import { useState, useCallback, useEffect } from "react"
import { X, ChevronLeft, ChevronRight, RotateCcw, GitFork } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import type { Branch, ArchivedTurn } from "@/lib/types"
import { cn } from "@/lib/utils"

interface BranchModalProps {
  branches: Branch[]
  branchPointTurnIndex: number
  onClose: () => void
  onRedoToTurn: (branchId: string, archiveTurnIndex: number) => void
  onRedoEntireBranch: (branchId: string) => void
}

function ArchivedTurnCard({
  turn,
  archiveIndex,
  branchId,
  onRedoToHere,
}: {
  turn: ArchivedTurn
  archiveIndex: number
  branchId: string
  onRedoToHere: (branchId: string, archiveTurnIndex: number) => void
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 overflow-hidden">
      <div className="p-3 space-y-2">
        {/* User message */}
        {turn.userMessage && (
          <div className="flex items-start gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-blue-500/60 mt-1.5 shrink-0" />
            <div className="text-sm text-zinc-300">{turn.userMessage}</div>
          </div>
        )}

        {/* Thinking preview */}
        {turn.thinkingBlocks.length > 0 && (
          <div className="flex items-start gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-violet-500/60 mt-1.5 shrink-0" />
            <div className="text-xs text-zinc-500 italic line-clamp-2">
              {turn.thinkingBlocks[0].slice(0, 200)}...
            </div>
          </div>
        )}

        {/* Assistant text */}
        {turn.assistantText.length > 0 && (
          <div className="flex items-start gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-green-500/60 mt-1.5 shrink-0" />
            <div className="text-sm text-zinc-400 line-clamp-3">
              {turn.assistantText.join("\n").slice(0, 300)}
            </div>
          </div>
        )}

        {/* Tool calls */}
        {turn.toolCalls.length > 0 && (
          <div className="flex items-start gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-zinc-500/60 mt-1.5 shrink-0" />
            <div className="flex flex-wrap gap-1">
              {turn.toolCalls.map((tc, i) => (
                <Badge
                  key={i}
                  variant="outline"
                  className={cn(
                    "text-[10px] px-1.5 py-0 h-4 font-mono",
                    tc.type === "Edit" ? "border-amber-700/50 text-amber-400" : "border-green-700/50 text-green-400"
                  )}
                >
                  {tc.type} {tc.filePath.split("/").pop()}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Redo button */}
      <div className="border-t border-zinc-800 px-3 py-1.5 flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-xs text-blue-400 hover:text-blue-300 gap-1"
          onClick={() => onRedoToHere(branchId, archiveIndex)}
        >
          <RotateCcw className="size-3 scale-x-[-1]" />
          Redo to here
        </Button>
      </div>
    </div>
  )
}

export function BranchModal({
  branches,
  branchPointTurnIndex,
  onClose,
  onRedoToTurn,
  onRedoEntireBranch,
}: BranchModalProps) {
  const [currentIndex, setCurrentIndex] = useState(0)

  const current = branches[currentIndex]
  if (!current) return null

  const goPrev = useCallback(() => {
    setCurrentIndex((i) => (i > 0 ? i - 1 : branches.length - 1))
  }, [branches.length])

  const goNext = useCallback(() => {
    setCurrentIndex((i) => (i < branches.length - 1 ? i + 1 : 0))
  }, [branches.length])

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") goPrev()
      else if (e.key === "ArrowRight") goNext()
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [goPrev, goNext])

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-2xl max-h-[80vh] bg-zinc-900 border-zinc-700 flex flex-col">
        <DialogHeader className="shrink-0">
          <div className="flex items-center justify-between">
            <DialogTitle className="flex items-center gap-2 text-zinc-100">
              <GitFork className="size-4 text-purple-400" />
              Branches from Turn {branchPointTurnIndex + 1}
            </DialogTitle>
          </div>

          {/* Branch navigation */}
          <div className="flex items-center gap-3 pt-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={goPrev}
              disabled={branches.length <= 1}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <div className="flex-1 text-center">
              <div className="text-sm font-medium text-zinc-200 truncate">
                {current.label}
              </div>
              <div className="text-[10px] text-zinc-500">
                Branch {currentIndex + 1} of {branches.length} &middot;{" "}
                {new Date(current.createdAt).toLocaleString()}
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={goNext}
              disabled={branches.length <= 1}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </DialogHeader>

        <Separator className="bg-zinc-800" />

        {/* Branch turns */}
        <div className="flex-1 overflow-y-auto space-y-3 py-3 px-1">
          {current.turns.map((turn, i) => (
            <ArchivedTurnCard
              key={i}
              turn={turn}
              archiveIndex={i}
              branchId={current.id}
              onRedoToHere={onRedoToTurn}
            />
          ))}
        </div>

        <Separator className="bg-zinc-800" />

        {/* Footer */}
        <div className="shrink-0 flex items-center justify-between py-2">
          <span className="text-xs text-zinc-500">
            {current.turns.length} turn{current.turns.length !== 1 ? "s" : ""} in this branch
          </span>
          <Button
            size="sm"
            className="bg-blue-600 hover:bg-blue-500 text-white gap-1.5"
            onClick={() => onRedoEntireBranch(current.id)}
          >
            <RotateCcw className="size-3.5 scale-x-[-1]" />
            Redo entire branch
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
```

**Step 2: Verify it compiles**

Run: `cd /Users/gentritbiba/.claude/agent-window && bunx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/components/BranchModal.tsx
git commit -m "feat(undo): add branch viewer modal with navigation and redo"
```

---

## Phase 4: Integration — Wire Everything Together

### Task 4.1: Update ConversationTimeline with Undo UI

**Files:**
- Modify: `src/components/ConversationTimeline.tsx`

This is the most complex integration. We need to:
1. Add `TurnContextMenu` wrapper around each turn
2. Add hover "Restore to here" button on turn headers
3. Add `BranchIndicator` on turn headers
4. Add dimming for undone turns
5. Add `UndoRedoBar` at the bottom

**Step 1: Update the props interface**

Add these props to `ConversationTimelineProps`:

```typescript
interface ConversationTimelineProps {
  session: ParsedSession
  activeTurnIndex: number | null
  activeToolCallId: string | null
  searchQuery: string
  expandAll: boolean
  // Undo/redo props
  undoCurrentTurnIndex?: number | null
  branchesAtTurn?: (turnIndex: number) => Branch[]
  onRestoreToHere?: (turnIndex: number) => void
  onRedoToHere?: (turnIndex: number) => void
  onRedoNext?: () => void
  onRedoAll?: () => void
  onOpenBranches?: (turnIndex: number) => void
}
```

**Step 2: Update the component body**

Import the new components at the top:

```typescript
import { TurnContextMenu } from "@/components/TurnContextMenu"
import { BranchIndicator } from "@/components/BranchIndicator"
import { UndoRedoBar } from "@/components/UndoRedoBar"
import { RotateCcw } from "lucide-react"
import type { Branch } from "@/lib/types"
```

In the `ConversationTimeline` function, compute undo state:

```typescript
const undoIdx = undoCurrentTurnIndex ?? null
const isUndoActive = undoIdx !== null && undoIdx < session.turns.length - 1
const undoneCount = isUndoActive ? session.turns.length - 1 - undoIdx : 0
```

Wrap each turn in `TurnContextMenu` and add dimming. Replace the return JSX to wrap turns:

For each turn in `filteredTurns.map(...)`, the turn div should be:
- Wrapped in `<TurnContextMenu>` if undo callbacks are provided
- Styled with `opacity-40` and dashed border if the turn is undone (index > undoIdx)

**Step 3: Add restore button to TurnSection header**

In `TurnSection`, add a hover-visible "Restore to here" button next to the turn number. Also pass branch-related props.

**Step 4: Add UndoRedoBar at the bottom of the timeline**

After the `filteredTurns.map(...)`, render:

```tsx
{isUndoActive && onRedoNext && onRedoAll && (
  <UndoRedoBar
    undoneCount={undoneCount}
    onRedoNext={onRedoNext}
    onRedoAll={onRedoAll}
  />
)}
```

This task is complex — the agent implementing it should read the current `ConversationTimeline.tsx` fully and apply all changes carefully while preserving existing functionality.

**Step 5: Verify it compiles**

Run: `cd /Users/gentritbiba/.claude/agent-window && bunx tsc --noEmit`

**Step 6: Commit**

```bash
git add src/components/ConversationTimeline.tsx
git commit -m "feat(undo): integrate undo/redo UI into conversation timeline"
```

---

### Task 4.2: Wire useUndoRedo into App.tsx

**Files:**
- Modify: `src/App.tsx`

**Step 1: Import and initialize the hook**

Add imports:

```typescript
import { useUndoRedo } from "@/hooks/useUndoRedo"
import { UndoConfirmDialog } from "@/components/UndoConfirmDialog"
import { BranchModal } from "@/components/BranchModal"
```

After the other hooks in `App()`, add:

```typescript
// Undo/redo system
const undoRedo = useUndoRedo(
  state.session,
  state.sessionSource,
  (updated) => dispatch({ type: "UPDATE_SESSION", session: updated }),
)

// Branch modal state
const [branchModalTurn, setBranchModalTurn] = useState<number | null>(null)
const branchModalBranches = branchModalTurn !== null ? undoRedo.branchesAtTurn(branchModalTurn) : []
```

**Step 2: Pass undo props to ConversationTimeline**

In both desktop and mobile layouts, update the `<ConversationTimeline>` usage to include undo props:

```tsx
<ConversationTimeline
  session={state.session}
  activeTurnIndex={state.activeTurnIndex}
  activeToolCallId={state.activeToolCallId}
  searchQuery={state.searchQuery}
  expandAll={state.expandAll}
  undoCurrentTurnIndex={undoRedo.undoState?.currentTurnIndex ?? null}
  branchesAtTurn={undoRedo.branchesAtTurn}
  onRestoreToHere={undoRedo.requestUndo}
  onRedoToHere={undoRedo.requestRedoToTurn}
  onRedoNext={undoRedo.requestRedoNext}
  onRedoAll={undoRedo.requestRedoAll}
  onOpenBranches={(turnIndex) => setBranchModalTurn(turnIndex)}
/>
```

**Step 3: Add dialog and modal renderers**

Before the closing `</div>` of the root element (both desktop and mobile), add:

```tsx
{/* Undo confirmation dialog */}
<UndoConfirmDialog
  state={undoRedo.confirmState}
  isApplying={undoRedo.isApplying}
  applyError={undoRedo.applyError}
  onConfirm={undoRedo.confirmApply}
  onCancel={undoRedo.confirmCancel}
/>

{/* Branch modal */}
{branchModalTurn !== null && branchModalBranches.length > 0 && (
  <BranchModal
    branches={branchModalBranches}
    branchPointTurnIndex={branchModalTurn}
    onClose={() => setBranchModalTurn(null)}
    onRedoToTurn={(branchId, archiveTurnIdx) => {
      undoRedo.requestBranchSwitch(branchId, archiveTurnIdx)
      setBranchModalTurn(null)
    }}
    onRedoEntireBranch={(branchId) => {
      undoRedo.requestBranchSwitch(branchId)
      setBranchModalTurn(null)
    }}
  />
)}
```

**Step 4: Verify it compiles**

Run: `cd /Users/gentritbiba/.claude/agent-window && bunx tsc --noEmit`

**Step 5: Commit**

```bash
git add src/App.tsx
git commit -m "feat(undo): wire undo/redo hook and modals into App"
```

---

### Task 4.3: Add Branching Logic to ChatInput Flow

**Files:**
- Modify: `src/App.tsx` (the `onSend` callback)

When the user sends a message while turns are undone, we need to:
1. Archive the undone turns as a new branch
2. Truncate the JSONL file
3. Clear the undo state
4. Then send the message normally

**Step 1: Create a branching wrapper around `claudeChat.sendMessage`**

In `App.tsx`, create a wrapper function:

```typescript
const handleSendWithBranching = useCallback(async (message: string) => {
  // If turns are undone, branch before sending
  if (undoRedo.isUndone && undoRedo.undoState && state.session && state.sessionSource) {
    const { undoState } = undoRedo
    const branchPointIndex = undoState.currentTurnIndex

    // Count JSONL lines that correspond to turns after the branch point
    // We need to figure out which raw JSONL lines to archive
    const rawLines = state.session.rawMessages
    // Find the line index where we need to truncate
    // Each turn starts with a user message; count user messages to find the cutoff
    let userMsgCount = 0
    let cutoffLineIndex = rawLines.length
    for (let i = 0; i < rawLines.length; i++) {
      const msg = rawLines[i]
      if (msg.type === "user" && !("isMeta" in msg && msg.isMeta)) {
        userMsgCount++
        if (userMsgCount > branchPointIndex + 1) {
          cutoffLineIndex = i
          break
        }
      }
    }

    // Get the raw JSONL text to find line boundaries
    const rawText = state.sessionSource.rawText
    if (rawText) {
      const allLines = rawText.split("\n").filter(Boolean)
      const linesToKeep = cutoffLineIndex
      const removedJsonlLines = allLines.slice(linesToKeep)

      if (removedJsonlLines.length > 0) {
        // Create branch from the undone turns
        const { createBranch: makeBranch } = await import("@/lib/undo-engine")
        const branch = makeBranch(
          state.session.turns,
          branchPointIndex,
          removedJsonlLines,
        )

        // Truncate JSONL file on server
        await fetch("/api/undo/truncate-jsonl", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            dirName: state.sessionSource.dirName,
            fileName: state.sessionSource.fileName,
            keepLines: linesToKeep,
          }),
        })

        // Save updated undo state with new branch
        const newUndoState = {
          ...undoState,
          currentTurnIndex: branchPointIndex,
          totalTurns: branchPointIndex + 1,
          branches: [...undoState.branches, branch],
          activeBranchId: null,
        }

        // Check branch limit
        if (newUndoState.branches.length > 20) {
          console.warn("Branch limit approaching:", newUndoState.branches.length)
        }

        await fetch(`/api/undo-state/${encodeURIComponent(undoState.sessionId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(newUndoState),
        })
      }
    }
  }

  // Send the message normally
  claudeChat.sendMessage(message)
}, [undoRedo, state.session, state.sessionSource, claudeChat])
```

**Step 2: Replace `claudeChat.sendMessage` with `handleSendWithBranching` in ChatInput**

In both desktop and mobile `<ChatInput>` usages, change `onSend={claudeChat.sendMessage}` to `onSend={handleSendWithBranching}`.

**Step 3: Add `rawText` to SessionSource type**

In `src/hooks/useLiveSession.ts`, check if `SessionSource` includes `rawText`. If not, add it:

```typescript
export interface SessionSource {
  dirName: string
  fileName: string
  rawText?: string  // Add this if not present
}
```

Make sure the raw text is stored when loading sessions. In `useSessionActions.ts`, the `handleLoadSession` callback already receives `rawText` from the fetch.

**Step 4: Verify it compiles**

Run: `cd /Users/gentritbiba/.claude/agent-window && bunx tsc --noEmit`

**Step 5: Commit**

```bash
git add src/App.tsx src/hooks/useLiveSession.ts src/hooks/useSessionActions.ts
git commit -m "feat(undo): add branching logic on send when turns are undone"
```

---

## Phase 5: Polish & Verify

### Task 5.1: Ensure Dialog UI Component Exists

**Files:**
- Possibly create: `src/components/ui/dialog.tsx`

Check if the project has a Dialog UI component (used by `UndoConfirmDialog` and `BranchModal`). If not, create it from the standard shadcn/ui Dialog template using Radix Dialog primitives.

**Step 1: Check and create if needed**

Run: `ls src/components/ui/dialog.tsx`

If missing, create it with the standard shadcn/ui dialog implementation.

**Step 2: Verify the full build passes**

Run: `cd /Users/gentritbiba/.claude/agent-window && bun run build`

**Step 3: Commit if changes were made**

```bash
git add src/components/ui/dialog.tsx
git commit -m "feat(ui): add dialog component for undo modals"
```

---

### Task 5.2: Final Build & Visual Verification

**Files:** None (verification only)

**Step 1: Run full build**

Run: `cd /Users/gentritbiba/.claude/agent-window && bun run build`
Expected: Build succeeds with no errors.

**Step 2: Run dev server and visually verify**

Run: `cd /Users/gentritbiba/.claude/agent-window && bun run dev`

Verify:
- Open a session with Edit/Write tool calls
- Hover over a turn header — "Restore to here" button appears
- Right-click a turn — context menu shows "Restore to this point"
- Click "Restore to here" — confirmation dialog appears
- After confirming — turns dim, redo bar appears
- Click "Redo Next" / "Redo All" — turns restore
- Send a message while undone — branch is created, indicator appears
- Click branch indicator — modal opens with full branch content
- Arrow keys navigate between branches in the modal

**Step 3: Final commit**

```bash
git add -A
git commit -m "feat(undo): complete undo/redo with session branching system"
```

---

## Task Dependency Graph

```
1.1 Types ──→ 1.2 Engine ──→ 2.1 Hook ──→ 4.1 Timeline UI ──→ 4.2 App Wiring ──→ 5.2 Verify
                    │                              │
                    └──→ 1.3 Server ──→ 2.1 Hook   │
                                                   │
              2.2 State ───────────────────────→ 4.2 App Wiring
                                                   │
              3.1 ConfirmDialog ───────────────→ 4.2 App Wiring
              3.2 ContextMenu ─────────────────→ 4.1 Timeline UI
              3.3 RedoBar ─────────────────────→ 4.1 Timeline UI
              3.4 BranchIndicator ─────────────→ 4.1 Timeline UI
              3.5 BranchModal ─────────────────→ 4.2 App Wiring
                                                   │
                                              4.3 Branching Logic ──→ 5.2 Verify
              5.1 Dialog Component ────────────→ 3.1, 3.5
```

**Parallelizable groups:**
- Group A (can run in parallel): Tasks 1.1, then 1.2 + 1.3 (both depend on 1.1)
- Group B (can run in parallel after 1.x): Tasks 2.1, 2.2, 3.1, 3.2, 3.3, 3.4, 3.5, 5.1
- Group C (sequential): Tasks 4.1 → 4.2 → 4.3 → 5.2
