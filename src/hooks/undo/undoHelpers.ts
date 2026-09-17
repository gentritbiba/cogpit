/**
 * Undo/redo helper utilities — summary building and JSONL line scanning.
 */

import {
  summarizeOperations,
  type FileOperation,
  type OperationSummary,
} from "@/lib/undo-engine"
import { agentKindForDirName } from "@/lib/agents"
import type { NativeRewindMode } from "@/lib/agents/nativeRewind"
import { cutLineForTurnCount, formatFor, turnBoundaryLines, turnStartsWithIds } from "../../../shared/session/agents"
import type { Turn } from "../../../shared/session/types"

export interface UndoConfirmState {
  type: "undo" | "redo" | "branch-switch"
  summary: OperationSummary
  targetTurnIndex: number
  branchId?: string
  branchTurnIndex?: number
  /** For partial redo: index into the archived turns array (inclusive) */
  redoUpToArchiveIndex?: number
  /** Set when the agent rewinds its own history instead of Cogpit cutting the transcript. */
  nativeRewind?: {
    eventId: string
    mode: NativeRewindMode
    filesAvailable?: boolean
  }
}

/**
 * The confirmation summary. `turnCount` is how many turns move, which the
 * operations cannot say: most turns touch no file at all.
 */
export function buildSummary(ops: FileOperation[], turnCount: number): OperationSummary {
  return { ...summarizeOperations(ops), turnCount }
}

/**
 * Find the JSONL line index where turn `keepTurnCount` ends.
 *
 * Delegates to the agent's own boundary scan in `shared/session`, which the
 * server's branch and undo routes call too — the client computes `keepLines`
 * and the server verifies it before cutting, so a disagreement of one line
 * between the two would write a corrupted transcript.
 */
export function findCutoffLine(
  allLines: string[],
  keepTurnCount: number,
  dirName: string | null | undefined,
): number {
  return cutLineForTurnCount(
    formatFor(agentKindForDirName(dirName)),
    allLines,
    keepTurnCount,
  )
}

export interface UndoCut {
  /** Line to cut at: everything from here on is removed. */
  cutoffLine: number
  /**
   * Id of the last turn kept, for anchoring the archived branch: null when no
   * turn is kept, undefined when the transcript has no id to anchor to.
   */
  branchPointTurnId: string | null | undefined
}

/**
 * Where to cut the full transcript to undo from `firstRemovedTurn` on.
 *
 * Resolved by turn id against a parse of the whole file, which is what makes
 * this safe: `session.turns` is only the loaded tail of a long session, so its
 * indexes do not line up with the full file's turns. Cutting by index would
 * keep N turns counted from the top of the *file* while the user picked the Nth
 * turn of the *window*, quietly deleting everything in between — and when the
 * user undoes from the first loaded turn, N is 0 and the whole transcript goes.
 *
 * Falls back to the index cut when neither turn's id survives a fresh parse —
 * an agent may leave a turn unlabelled — which is only correct while the whole
 * session is loaded. With more turns in the file than in the window there is
 * no safe cut, and the answer is null.
 */
export function resolveUndoCut(
  allLines: string[],
  lastKeptTurn: Turn | undefined,
  firstRemovedTurn: Turn | undefined,
  keepTurnCount: number,
  loadedTurnCount: number,
  dirName: string | null | undefined,
): UndoCut | null {
  const format = formatFor(agentKindForDirName(dirName))
  const starts = turnStartsWithIds(format, allLines)
  if (starts) {
    const kept = lastKeptTurn ? starts.findLastIndex((start) => start.id === lastKeptTurn.id) : -1
    if (kept >= 0) {
      return { cutoffLine: starts[kept + 1]?.line ?? allLines.length, branchPointTurnId: starts[kept].id }
    }
    const removed = firstRemovedTurn ? starts.findIndex((start) => start.id === firstRemovedTurn.id) : -1
    if (removed >= 0) {
      return { cutoffLine: starts[removed].line, branchPointTurnId: starts[removed - 1]?.id ?? null }
    }
  }
  if (turnBoundaryLines(format, allLines).length > loadedTurnCount) return null
  return { cutoffLine: cutLineForTurnCount(format, allLines, keepTurnCount), branchPointTurnId: undefined }
}
