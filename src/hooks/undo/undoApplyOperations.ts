/**
 * Undo/redo apply operations — file mutation + JSONL truncation/append.
 */

import type { ParsedSession, UndoState, Branch } from "../../../shared/session/types"
import type { SessionSource } from "../useLiveSession"
import {
  anchorChildBranches,
  buildUndoOperations,
  buildRedoFromArchived,
  createBranch,
  collectChildBranches,
  splitChildBranches,
  type FileOperation,
} from "@/lib/undo-engine"
import { findCutoffLine, resolveUndoCut, type UndoConfirmState, type UndoCut } from "./undoHelpers"
import type { UndoSessionMutation } from "../../../shared/contracts/undo"
import { capabilitiesForDirName } from "@/lib/agents"

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

const TURN_NOT_FOUND = "Unable to locate the selected turn in the current session file"

/** The cut that keeps the first `keepTurnCount` loaded turns, or an aborted apply when it cannot be placed. */
function locateCut(
  session: ParsedSession,
  sessionSource: SessionSource,
  allLines: string[],
  keepTurnCount: number,
  setApplyError: (e: string) => void,
): UndoCut {
  const cut = resolveUndoCut(
    allLines,
    session.turns[keepTurnCount - 1],
    session.turns[keepTurnCount],
    keepTurnCount,
    session.turns.length,
    sessionSource.dirName,
  )
  if (!cut) {
    setApplyError(TURN_NOT_FOUND)
    throw new ApplyAbort()
  }
  return cut
}

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
  // `allLines` is the whole file while `session.turns` may be only its tail, so
  // the cut has to be anchored to the turn itself, not to its window index.
  const { cutoffLine, branchPointTurnId } = locateCut(session, sessionSource, allLines, keepTurnCount, setApplyError)
  const removedJsonlLines = allLines.slice(cutoffLine)

  if (removedJsonlLines.length === 0) {
    setApplyError(TURN_NOT_FOUND)
    throw new ApplyAbort()
  }

  const { retained, scooped } = collectChildBranches(state.branches, effectiveTarget)
  const branch = createBranch(session.turns, effectiveTarget, removedJsonlLines, scooped, branchPointTurnId)
  const nextState: UndoState = {
    ...state,
    branches: [...retained, branch],
    activeBranchId: null,
  }
  // Only an agent that checkpoints files itself can restore them from a turn id.
  const rewindTarget = capabilitiesForDirName(sessionSource.dirName).fileCheckpoints
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

/**
 * What restoring `branch` through archived turn `upToIdx` puts back into the
 * transcript, and what takes the branch's place in the undo state: the rest of
 * a partly restored branch plus the children that fork inside the restored
 * range, or all of its children once it is restored whole.
 */
function restoreFromBranch(
  branch: Branch,
  upToIdx: number,
  dirName: string,
): { restoredLines: string[]; replacement: Branch[] } {
  const redoTurnCount = upToIdx + 1
  const children = anchorChildBranches(branch)
  const cutoff = upToIdx < branch.turns.length - 1
    ? findCutoffLine(branch.jsonlLines, redoTurnCount, dirName)
    : branch.jsonlLines.length
  const restoredLines = branch.jsonlLines.slice(0, cutoff)
  const remainingLines = branch.jsonlLines.slice(cutoff)
  if (remainingLines.length === 0) return { restoredLines, replacement: children }

  const { restored, remaining } = splitChildBranches(children, branch.branchPointTurnIndex, redoTurnCount)
  return {
    restoredLines,
    replacement: [
      {
        ...branch,
        branchPointTurnIndex: branch.branchPointTurnIndex + redoTurnCount,
        // Without an id on the archived turn the index is all there is.
        branchPointTurnId: branch.turns[redoTurnCount - 1]?.id,
        turns: branch.turns.slice(redoTurnCount),
        jsonlLines: remainingLines,
        label: branch.turns[redoTurnCount]?.userMessage || branch.label,
        childBranches: remaining.length > 0 ? remaining : undefined,
      },
      ...restored,
    ],
  }
}

export async function applyRedo(
  confirmState: UndoConfirmState,
  sessionSource: SessionSource,
  state: UndoState,
  branch: Branch,
  freshRawText: string,
  commitTransaction: CommitUndoTransaction,
): Promise<void> {
  const upToIdx = confirmState.redoUpToArchiveIndex ?? branch.turns.length - 1
  const { restoredLines, replacement } = restoreFromBranch(branch, upToIdx, sessionSource.dirName)
  const ops = buildRedoFromArchived(branch.turns, upToIdx)

  const nextState: UndoState = {
    ...state,
    branches: [...state.branches.filter((b) => b.id !== branch.id), ...replacement],
    activeBranchId: null,
  }
  const currentLines = freshRawText.split("\n").filter(Boolean)
  await commitTransaction({
    operations: ops,
    sessionSource,
    sessionMutation: {
      type: "append",
      lines: restoredLines,
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
  setApplyError: (e: string) => void,
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
    const { cutoffLine, branchPointTurnId } = locateCut(session, sessionSource, sessionLines, keepTurnCount, setApplyError)
    const removedJsonlLines = sessionLines.slice(cutoffLine)

    if (removedJsonlLines.length > 0) {
      const currentBranch = createBranch(session.turns, branch.branchPointTurnIndex, removedJsonlLines, scooped, branchPointTurnId)
      updatedBranches = [...updatedBranches, currentBranch]
      sessionLines = sessionLines.slice(0, cutoffLine)
    }
  }

  const upToIdx = confirmState.branchTurnIndex ?? branch.turns.length - 1
  const { restoredLines, replacement } = restoreFromBranch(branch, upToIdx, sessionSource.dirName)
  operations.push(...buildRedoFromArchived(branch.turns, upToIdx))

  const nextState: UndoState = {
    ...state,
    branches: [
      ...updatedBranches.filter((b) => b.id !== branch.id),
      ...replacement,
    ],
    activeBranchId: null,
  }

  await commitTransaction({
    operations,
    sessionSource,
    sessionMutation: {
      type: "splice",
      keepLines: sessionLines.length,
      lines: restoredLines,
      expectedLineCount: freshRawText.split("\n").filter(Boolean).length,
    },
    state: nextState,
  })
}
