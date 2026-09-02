/**
 * Undo/redo helper utilities — summary building and JSONL line scanning.
 */

import {
  summarizeOperations,
  type FileOperation,
  type OperationSummary,
} from "@/lib/undo-engine"
import { agentKindForDirName } from "@/lib/agents"
import { cutLineAfterUuid, cutLineForTurnCount, formatFor } from "../../../shared/session/agents"
import type { Turn } from "../../../shared/session/types"

export interface UndoConfirmState {
  type: "undo" | "redo" | "branch-switch"
  summary: OperationSummary
  targetTurnIndex: number
  branchId?: string
  branchTurnIndex?: number
  /** For partial redo: index into the archived turns array (inclusive) */
  redoUpToArchiveIndex?: number
  copilot?: {
    eventId: string
    mode: "conversation" | "conversation-and-files"
    filesAvailable?: boolean
  }
}

/** Build an OperationSummary, falling back to a turnCount-only summary when ops is empty. */
export function buildSummary(ops: FileOperation[], fallbackTurnCount: number): OperationSummary {
  if (ops.length > 0) return summarizeOperations(ops)
  return { turnCount: fallbackTurnCount, fileCount: 0, filePaths: [], operationCount: 0 }
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

/**
 * Line to cut at to keep everything through `lastKeptTurn`.
 *
 * Prefers the turn's own uuid, which is what makes this safe: `session.turns`
 * is only the loaded tail of a long session, so its indexes do not line up with
 * the full file's turns. Cutting by index would keep N turns counted from the
 * top of the *file* while the user picked the Nth turn of the *window*, quietly
 * deleting everything in between. Falls back to the index cut when there is no
 * uuid to match — not every agent writes one — which is the pre-existing
 * behaviour and is correct whenever the whole session is loaded.
 *
 * Mirrors the server's branch route, which resolves the same way.
 */
export function findCutoffLineForTurn(
  allLines: string[],
  lastKeptTurn: Turn | undefined,
  keepTurnCount: number,
  dirName: string | null | undefined,
): number {
  const format = formatFor(agentKindForDirName(dirName))
  // `Turn.id` is the originating record's uuid where the agent writes one, and
  // a generated id otherwise (turnBuilder.ts). An unmatched id simply falls
  // through to the index cut, which is what agents whose turns carry no uuid
  // have always used. Same resolution order as the server's branch route.
  const turnUuid = lastKeptTurn?.id
  if (turnUuid) {
    const byUuid = cutLineAfterUuid(format, allLines, turnUuid)
    if (byUuid === "keep-all") return allLines.length
    if (byUuid !== null) return byUuid
  }
  return cutLineForTurnCount(format, allLines, keepTurnCount)
}
