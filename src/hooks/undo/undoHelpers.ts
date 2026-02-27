/**
 * Undo/redo helper utilities — summary building and JSONL line scanning.
 */

import {
  summarizeOperations,
  type FileOperation,
  type OperationSummary,
} from "@/lib/undo-engine"

export type { OperationSummary }

export interface UndoConfirmState {
  type: "undo" | "redo" | "branch-switch"
  summary: OperationSummary
  targetTurnIndex: number
  branchId?: string
  branchTurnIndex?: number
  /** For partial redo: index into the archived turns array (inclusive) */
  redoUpToArchiveIndex?: number
}

/** Build an OperationSummary, falling back to a turnCount-only summary when ops is empty. */
export function buildSummary(ops: FileOperation[], fallbackTurnCount: number): OperationSummary {
  if (ops.length > 0) return summarizeOperations(ops)
  return { turnCount: fallbackTurnCount, fileCount: 0, filePaths: [], operationCount: 0 }
}

/** Check if a JSONL user message starts a new turn (not meta, not a tool_result). */
export function isTurnStartingUserMessage(obj: Record<string, unknown>): boolean {
  if (obj.type !== "user" || obj.isMeta) return false
  const content = (obj as { message?: { content?: unknown } }).message?.content
  if (Array.isArray(content) && content.some((b: { type: string }) => b.type === "tool_result")) {
    return false
  }
  return true
}

/**
 * Find the JSONL line index where turn `keepTurnCount` ends.
 * Parses JSONL lines directly (robust against skipped lines in rawMessages).
 */
export function findCutoffLine(allLines: string[], keepTurnCount: number): number {
  let userMsgCount = 0
  for (let i = 0; i < allLines.length; i++) {
    try {
      const obj = JSON.parse(allLines[i])
      if (isTurnStartingUserMessage(obj)) {
        userMsgCount++
        if (userMsgCount > keepTurnCount) return i
      }
    } catch { /* skip malformed */ }
  }
  return allLines.length
}
