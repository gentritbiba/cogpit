/**
 * Undo/redo apply operations — file mutation + JSONL truncation/append.
 */

import type { ParsedSession, UndoState, Branch } from "@/lib/types"
import type { SessionSource } from "../useLiveSession"
import { authFetch } from "@/lib/auth"
import {
  buildUndoOperations,
  buildRedoFromArchived,
  createBranch,
  collectChildBranches,
  splitChildBranches,
  type FileOperation,
} from "@/lib/undo-engine"
import { findCutoffLine, type UndoConfirmState } from "./undoHelpers"

/** Sentinel error to abort confirm-apply without setting an error message. */
export class ApplyAbort extends Error { constructor() { super("abort") } }

export async function tryApplyOps(
  ops: FileOperation[],
  applyOperations: (ops: FileOperation[]) => Promise<boolean>,
): Promise<void> {
  if (ops.length === 0) return
  const success = await applyOperations(ops)
  if (!success) throw new ApplyAbort()
}

export async function truncateJsonl(
  sessionSource: SessionSource,
  keepLines: number,
  setApplyError: (e: string) => void,
): Promise<void> {
  const res = await authFetch("/api/undo/truncate-jsonl", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dirName: sessionSource.dirName, fileName: sessionSource.fileName, keepLines }),
  })
  if (!res.ok) {
    setApplyError("Failed to truncate session file")
    throw new ApplyAbort()
  }
}

export async function appendJsonl(
  sessionSource: SessionSource,
  lines: string[],
  setApplyError: (e: string) => void,
): Promise<void> {
  if (lines.length === 0) return
  const res = await authFetch("/api/undo/append-jsonl", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dirName: sessionSource.dirName, fileName: sessionSource.fileName, lines }),
  })
  if (!res.ok) {
    setApplyError("Failed to append session data")
    throw new ApplyAbort()
  }
}

export async function applyUndo(
  confirmState: UndoConfirmState,
  session: ParsedSession,
  sessionSource: SessionSource,
  state: UndoState,
  freshRawText: string,
  applyOperations: (ops: FileOperation[]) => Promise<boolean>,
  saveUndoState: (s: UndoState) => Promise<void>,
  setApplyError: (e: string) => void,
): Promise<void> {
  const effectiveTarget = confirmState.targetTurnIndex

  // TODO: If file revert succeeds but JSONL truncation fails, we're in a
  // half-applied state. Consider reordering (truncate first) or adding rollback.
  const ops = buildUndoOperations(session.turns, session.turns.length - 1, effectiveTarget)
  await tryApplyOps(ops, applyOperations)

  // Archive undone turns + truncate JSONL
  const keepTurnCount = effectiveTarget + 1
  const allLines = freshRawText.split("\n").filter(Boolean)
  const cutoffLine = findCutoffLine(allLines, keepTurnCount)
  const removedJsonlLines = allLines.slice(cutoffLine)

  if (removedJsonlLines.length === 0) return

  const { retained, scooped } = collectChildBranches(state.branches, effectiveTarget)
  const branch = createBranch(session.turns, effectiveTarget, removedJsonlLines, scooped)
  await truncateJsonl(sessionSource, cutoffLine, setApplyError)

  await saveUndoState({
    ...state,
    currentTurnIndex: effectiveTarget,
    totalTurns: keepTurnCount,
    branches: [...retained, branch],
    activeBranchId: null,
  })
}

export async function applyRedo(
  confirmState: UndoConfirmState,
  sessionSource: SessionSource,
  state: UndoState,
  branch: Branch,
  applyOperations: (ops: FileOperation[]) => Promise<boolean>,
  saveUndoState: (s: UndoState) => Promise<void>,
  setApplyError: (e: string) => void,
): Promise<void> {
  const isPartial = confirmState.redoUpToArchiveIndex !== undefined
    && confirmState.redoUpToArchiveIndex < branch.turns.length - 1
  const upToIdx = confirmState.redoUpToArchiveIndex ?? branch.turns.length - 1
  const redoTurnCount = upToIdx + 1

  // 1. Apply file changes
  const ops = buildRedoFromArchived(branch.turns, upToIdx)
  await tryApplyOps(ops, applyOperations)

  // 2. Determine which JSONL lines to append
  const cutoff = isPartial ? findCutoffLine(branch.jsonlLines, redoTurnCount) : branch.jsonlLines.length
  const linesToAppend = branch.jsonlLines.slice(0, cutoff)
  const remainingLines = branch.jsonlLines.slice(cutoff)

  await appendJsonl(sessionSource, linesToAppend, setApplyError)

  // 3. Update state -- restore child branches that are now in range
  const children = branch.childBranches ?? []
  let newBranches: Branch[]
  if (isPartial && remainingLines.length > 0) {
    const { restored, remaining: remainingChildren } = splitChildBranches(
      children, branch.branchPointTurnIndex, redoTurnCount
    )
    const updatedBranch: Branch = {
      ...branch,
      branchPointTurnIndex: branch.branchPointTurnIndex + redoTurnCount,
      turns: branch.turns.slice(redoTurnCount),
      jsonlLines: remainingLines,
      label: branch.turns[redoTurnCount]?.userMessage || branch.label,
      childBranches: remainingChildren.length > 0 ? remainingChildren : undefined,
    }
    newBranches = [
      ...state.branches.map((b) => b.id === branch.id ? updatedBranch : b),
      ...restored,
    ]
  } else {
    newBranches = [
      ...state.branches.filter((b) => b.id !== branch.id),
      ...children,
    ]
  }

  await saveUndoState({
    ...state,
    currentTurnIndex: state.currentTurnIndex + redoTurnCount,
    totalTurns: state.totalTurns + redoTurnCount,
    branches: newBranches,
    activeBranchId: null,
  })
}

export async function applyBranchSwitch(
  session: ParsedSession,
  sessionSource: SessionSource,
  state: UndoState,
  branch: Branch,
  freshRawText: string,
  applyOperations: (ops: FileOperation[]) => Promise<boolean>,
  saveUndoState: (s: UndoState) => Promise<void>,
  setApplyError: (e: string) => void,
): Promise<void> {
  let updatedBranches = [...state.branches]

  // If we have turns past the branch point, undo + archive them first
  if (session.turns.length > branch.branchPointTurnIndex + 1) {
    const undoOps = buildUndoOperations(
      session.turns, session.turns.length - 1, branch.branchPointTurnIndex,
    )
    await tryApplyOps(undoOps, applyOperations)

    const { retained, scooped } = collectChildBranches(updatedBranches, branch.branchPointTurnIndex)
    updatedBranches = retained

    const keepTurnCount = branch.branchPointTurnIndex + 1
    const allLines = freshRawText.split("\n").filter(Boolean)
    const cutoffLine = findCutoffLine(allLines, keepTurnCount)
    const removedJsonlLines = allLines.slice(cutoffLine)

    if (removedJsonlLines.length > 0) {
      const currentBranch = createBranch(session.turns, branch.branchPointTurnIndex, removedJsonlLines, scooped)
      updatedBranches = [...updatedBranches, currentBranch]
      await truncateJsonl(sessionSource, cutoffLine, setApplyError)
    }
  }

  // Apply target branch's file changes + append JSONL
  const redoOps = buildRedoFromArchived(branch.turns)
  await tryApplyOps(redoOps, applyOperations)
  await appendJsonl(sessionSource, branch.jsonlLines, setApplyError)

  await saveUndoState({
    ...state,
    currentTurnIndex: branch.branchPointTurnIndex + branch.turns.length,
    totalTurns: branch.branchPointTurnIndex + 1 + branch.turns.length,
    branches: [
      ...updatedBranches.filter((b) => b.id !== branch.id),
      ...(branch.childBranches ?? []),
    ],
    activeBranchId: null,
  })
}
