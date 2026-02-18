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
      const replaceAll = tc.input.replace_all as boolean | undefined
      if (oldStr !== undefined && newStr !== undefined && filePath) {
        calls.push({ type: "Edit", filePath, oldString: oldStr, newString: newStr, replaceAll: replaceAll ?? false })
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
  replaceAll?: boolean
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
      if (!call) continue
      if (call.type === "Edit") {
        ops.push({
          type: "reverse-edit",
          filePath: call.filePath,
          // Swap: to undo, the "old" becomes what we write, "new" becomes what we find
          oldString: call.newString,
          newString: call.oldString,
          replaceAll: call.replaceAll,
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
          replaceAll: call.replaceAll,
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
    if (!at) continue
    for (const call of at.toolCalls) {
      if (call.type === "Edit") {
        ops.push({
          type: "apply-edit",
          filePath: call.filePath,
          oldString: call.oldString,
          newString: call.newString,
          replaceAll: call.replaceAll,
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
  jsonlLines: string[],
  childBranches?: Branch[]
): Branch {
  const archivedTurns: ArchivedTurn[] = []
  for (let i = branchPointTurnIndex + 1; i < turns.length; i++) {
    const turn = turns[i]
    if (!turn) continue
    archivedTurns.push(archiveTurn(turn, i))
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
    ...(childBranches && childBranches.length > 0 ? { childBranches } : {}),
  }
}

// ── Nested branch helpers ────────────────────────────────────────────────

/**
 * When undoing past a certain turn, branches whose branchPointTurnIndex > cutoff
 * become orphaned (their reference turn no longer exists). This splits branches
 * into those we keep (at or before cutoff) and those we scoop into the new branch.
 */
export function collectChildBranches(
  branches: Branch[],
  cutoffTurnIndex: number
): { retained: Branch[]; scooped: Branch[] } {
  const retained: Branch[] = []
  const scooped: Branch[] = []
  for (const b of branches) {
    if (b.branchPointTurnIndex > cutoffTurnIndex) {
      scooped.push(b)
    } else {
      retained.push(b)
    }
  }
  return { retained, scooped }
}

/**
 * When restoring a branch (redo), determine which of its child branches
 * can be safely returned to the top-level state (their branchPointTurnIndex
 * is within the restored range) and which must stay nested.
 */
export function splitChildBranches(
  childBranches: Branch[],
  parentBranchPoint: number,
  redoTurnCount: number
): { restored: Branch[]; remaining: Branch[] } {
  const maxValidIndex = parentBranchPoint + redoTurnCount
  const restored: Branch[] = []
  const remaining: Branch[] = []
  for (const b of childBranches) {
    if (b.branchPointTurnIndex <= maxValidIndex) {
      restored.push(b)
    } else {
      remaining.push(b)
    }
  }
  return { restored, remaining }
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
