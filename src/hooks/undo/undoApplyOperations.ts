/**
 * Undo/redo apply operations — file mutation + JSONL truncation/append.
 */

import type { ParsedSession, UndoState, Branch } from "@/lib/types"
import type { SessionSource } from "../useLiveSession"
import {
  buildUndoOperations,
  buildRedoFromArchived,
  createBranch,
  collectChildBranches,
  splitChildBranches,
  type FileOperation,
} from "@/lib/undo-engine"
import { findCutoffLine, type UndoConfirmState } from "./undoHelpers"
import type { UndoSessionMutation } from "../../../shared/contracts/undo"

/** Sentinel error to abort confirm-apply without setting an error message. */
export class ApplyAbort extends Error { constructor() { super("abort") } }

interface TransactionCheckpoint {
  sessionId: string
  userMessageId: string
  cwd: string
}

export interface UndoTransaction {
  operations: FileOperation[]
  sessionSource: SessionSource
  sessionMutation: UndoSessionMutation
  state: UndoState
  checkpoint?: TransactionCheckpoint
}

export type CommitUndoTransaction = (transaction: UndoTransaction) => Promise<void>

export async function applyUndo(
  confirmState: UndoConfirmState,
  session: ParsedSession,
  sessionSource: SessionSource,
  state: UndoState,
  freshRawText: string,
  commitTransaction: CommitUndoTransaction,
  setApplyError: (e: string) => void,
): Promise<void> {
  const effectiveTarget = confirmState.targetTurnIndex
  const ops = buildUndoOperations(session.turns, session.turns.length - 1, effectiveTarget)
  const keepTurnCount = effectiveTarget + 1
  const allLines = freshRawText.split("\n").filter(Boolean)
  const cutoffLine = findCutoffLine(allLines, keepTurnCount)
  const removedJsonlLines = allLines.slice(cutoffLine)

  if (removedJsonlLines.length === 0) {
    setApplyError("Unable to locate the selected turn in the current session file")
    throw new ApplyAbort()
  }

  const { retained, scooped } = collectChildBranches(state.branches, effectiveTarget)
  const branch = createBranch(session.turns, effectiveTarget, removedJsonlLines, scooped)
  const nextState: UndoState = {
    ...state,
    currentTurnIndex: effectiveTarget,
    totalTurns: keepTurnCount,
    branches: [...retained, branch],
    activeBranchId: null,
  }
  const rewindTarget = session.agentKind === "claude"
    ? session.turns[effectiveTarget + 1]?.id
    : undefined

  await commitTransaction({
    operations: ops,
    sessionSource,
    sessionMutation: {
      type: "truncate",
      keepLines: cutoffLine,
      expectedLineCount: allLines.length,
    },
    state: nextState,
    ...(rewindTarget ? {
      checkpoint: {
        sessionId: session.sessionId,
        userMessageId: rewindTarget,
        cwd: session.cwd,
      },
    } : {}),
  })
}

export async function applyRedo(
  confirmState: UndoConfirmState,
  sessionSource: SessionSource,
  state: UndoState,
  branch: Branch,
  freshRawText: string,
  commitTransaction: CommitUndoTransaction,
): Promise<void> {
  const isPartial = confirmState.redoUpToArchiveIndex !== undefined
    && confirmState.redoUpToArchiveIndex < branch.turns.length - 1
  const upToIdx = confirmState.redoUpToArchiveIndex ?? branch.turns.length - 1
  const redoTurnCount = upToIdx + 1

  const ops = buildRedoFromArchived(branch.turns, upToIdx)
  const cutoff = isPartial ? findCutoffLine(branch.jsonlLines, redoTurnCount) : branch.jsonlLines.length
  const linesToAppend = branch.jsonlLines.slice(0, cutoff)
  const remainingLines = branch.jsonlLines.slice(cutoff)
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

  const nextState: UndoState = {
    ...state,
    currentTurnIndex: state.currentTurnIndex + redoTurnCount,
    totalTurns: state.totalTurns + redoTurnCount,
    branches: newBranches,
    activeBranchId: null,
  }
  const currentLines = freshRawText.split("\n").filter(Boolean)
  await commitTransaction({
    operations: ops,
    sessionSource,
    sessionMutation: {
      type: "append",
      lines: linesToAppend,
      expectedLineCount: currentLines.length,
    },
    state: nextState,
  })
}

export async function applyBranchSwitch(
  session: ParsedSession,
  sessionSource: SessionSource,
  state: UndoState,
  branch: Branch,
  freshRawText: string,
  confirmState: UndoConfirmState,
  commitTransaction: CommitUndoTransaction,
): Promise<void> {
  let updatedBranches = [...state.branches]
  let sessionLines = freshRawText.split("\n").filter(Boolean)
  const operations: FileOperation[] = []

  // If we have turns past the branch point, undo + archive them first
  if (session.turns.length > branch.branchPointTurnIndex + 1) {
    const undoOps = buildUndoOperations(
      session.turns, session.turns.length - 1, branch.branchPointTurnIndex,
    )
    operations.push(...undoOps)

    const { retained, scooped } = collectChildBranches(updatedBranches, branch.branchPointTurnIndex)
    updatedBranches = retained

    const keepTurnCount = branch.branchPointTurnIndex + 1
    const cutoffLine = findCutoffLine(sessionLines, keepTurnCount)
    const removedJsonlLines = sessionLines.slice(cutoffLine)

    if (removedJsonlLines.length > 0) {
      const currentBranch = createBranch(session.turns, branch.branchPointTurnIndex, removedJsonlLines, scooped)
      updatedBranches = [...updatedBranches, currentBranch]
      sessionLines = sessionLines.slice(0, cutoffLine)
    }
  }

  const upToIdx = confirmState.branchTurnIndex ?? branch.turns.length - 1
  const redoTurnCount = upToIdx + 1
  const isPartial = upToIdx < branch.turns.length - 1
  const redoOps = buildRedoFromArchived(branch.turns, upToIdx)
  operations.push(...redoOps)
  const jsonlCutoff = isPartial
    ? findCutoffLine(branch.jsonlLines, redoTurnCount)
    : branch.jsonlLines.length
  const restoredJsonlLines = branch.jsonlLines.slice(0, jsonlCutoff)
  const remainingJsonlLines = branch.jsonlLines.slice(jsonlCutoff)

  const children = branch.childBranches ?? []
  let targetReplacement: Branch[]
  if (isPartial && remainingJsonlLines.length > 0) {
    const { restored, remaining } = splitChildBranches(
      children,
      branch.branchPointTurnIndex,
      redoTurnCount,
    )
    targetReplacement = [
      {
        ...branch,
        branchPointTurnIndex: branch.branchPointTurnIndex + redoTurnCount,
        turns: branch.turns.slice(redoTurnCount),
        jsonlLines: remainingJsonlLines,
        label: branch.turns[redoTurnCount]?.userMessage || branch.label,
        childBranches: remaining.length > 0 ? remaining : undefined,
      },
      ...restored,
    ]
  } else {
    targetReplacement = children
  }

  const nextState: UndoState = {
    ...state,
    currentTurnIndex: branch.branchPointTurnIndex + redoTurnCount,
    totalTurns: branch.branchPointTurnIndex + 1 + redoTurnCount,
    branches: [
      ...updatedBranches.filter((b) => b.id !== branch.id),
      ...targetReplacement,
    ],
    activeBranchId: null,
  }

  await commitTransaction({
    operations,
    sessionSource,
    sessionMutation: {
      type: "splice",
      keepLines: sessionLines.length,
      lines: restoredJsonlLines,
      expectedLineCount: freshRawText.split("\n").filter(Boolean).length,
    },
    state: nextState,
  })
}
