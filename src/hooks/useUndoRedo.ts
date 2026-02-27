import { useState, useCallback, useRef, useEffect, useMemo } from "react"
import type { ParsedSession, UndoState, Branch, Turn } from "@/lib/types"
import type { SessionSource } from "./useLiveSession"
import { parseSession } from "@/lib/parser"
import { authFetch } from "@/lib/auth"
import {
  buildUndoOperations,
  buildRedoFromArchived,
  summarizeOperations,
  createEmptyUndoState,
  createBranch,
  collectChildBranches,
  splitChildBranches,
  type FileOperation,
  type OperationSummary,
} from "@/lib/undo-engine"

const EMPTY_BRANCHES: Branch[] = []

export interface UndoConfirmState {
  type: "undo" | "redo" | "branch-switch"
  summary: OperationSummary
  targetTurnIndex: number
  branchId?: string
  branchTurnIndex?: number
  /** For partial redo: index into the archived turns array (inclusive) */
  redoUpToArchiveIndex?: number
}

export interface UseUndoRedoResult {
  undoState: UndoState | null
  canRedo: boolean
  redoTurnCount: number
  redoGhostTurns: Turn[]
  branches: Branch[]
  branchesAtTurn: (turnIndex: number) => Branch[]

  // Actions
  requestUndo: (targetTurnIndex: number) => void
  requestRedoAll: () => void
  requestRedoUpTo: (ghostTurnIndex: number) => void
  requestBranchSwitch: (branchId: string, archiveTurnIndex?: number) => void

  // Confirmation dialog
  confirmState: UndoConfirmState | null
  confirmApply: () => Promise<void>
  confirmCancel: () => void

  // Loading
  isApplying: boolean
  applyError: string | null
}

/** Build an OperationSummary, falling back to a turnCount-only summary when ops is empty. */
function buildSummary(ops: FileOperation[], fallbackTurnCount: number): OperationSummary {
  if (ops.length > 0) return summarizeOperations(ops)
  return { turnCount: fallbackTurnCount, fileCount: 0, filePaths: [], operationCount: 0 }
}

/** Check if a JSONL user message starts a new turn (not meta, not a tool_result). */
function isTurnStartingUserMessage(obj: Record<string, unknown>): boolean {
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
function findCutoffLine(allLines: string[], keepTurnCount: number): number {
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

export function useUndoRedo(
  session: ParsedSession | null,
  sessionSource: SessionSource | null,
  onReloadSession: () => Promise<void>,
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

    // Capture the id so we can check for staleness when the fetch resolves
    const fetchedSessionId = session.sessionId
    const controller = new AbortController()

    authFetch(`/api/undo-state/${encodeURIComponent(fetchedSessionId)}`, {
      signal: controller.signal,
    })
      .then((res) => res.ok ? res.json() : null)
      .then((data: UndoState | null) => {
        // Only apply if this session is still current
        if (sessionIdRef.current === fetchedSessionId) {
          setUndoState(data ?? null)
        }
      })
      .catch((err) => {
        if (err instanceof Error && err.name === "AbortError") return
        if (sessionIdRef.current === fetchedSessionId) {
          setUndoState(null)
        }
      })

    return () => controller.abort()
  }, [session?.sessionId])

  // Save undo state to server
  const saveUndoState = useCallback(async (state: UndoState) => {
    setUndoState(state)
    try {
      await authFetch(`/api/undo-state/${encodeURIComponent(state.sessionId)}`, {
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
    try {
      const res = await authFetch("/api/undo/apply", {
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
    }
  }, [])

  const branches = undoState?.branches ?? EMPTY_BRANCHES

  // canRedo: true if most recent branch's branchPoint + 1 === current session length
  // (no new turns added since the undo)
  const { canRedo, redoTurnCount, redoBranch } = useMemo((): { canRedo: boolean; redoTurnCount: number; redoBranch: Branch | null } => {
    if (!session || branches.length === 0) {
      return { canRedo: false, redoTurnCount: 0, redoBranch: null }
    }
    // Check most recent branch first (most likely candidate)
    for (let i = branches.length - 1; i >= 0; i--) {
      const b = branches[i]
      if (b.branchPointTurnIndex + 1 === session.turns.length) {
        return { canRedo: true, redoTurnCount: b.turns.length, redoBranch: b }
      }
    }
    return { canRedo: false, redoTurnCount: 0, redoBranch: null }
  }, [session, branches])

  // Parse the redo branch's JSONL lines into full Turn objects for ghost rendering
  const redoGhostTurns = useMemo<Turn[]>(() => {
    if (!redoBranch || redoBranch.jsonlLines.length === 0) return []
    try {
      const parsed = parseSession(redoBranch.jsonlLines.join("\n"))
      return parsed.turns
    } catch {
      return []
    }
  }, [redoBranch])

  const branchesAtTurn = useCallback((turnIndex: number) => {
    return branches.filter((b) => b.branchPointTurnIndex === turnIndex)
  }, [branches])

  // Request undo: "Restore to here" on turn N keeps turns 0..(N-1)
  const requestUndo = useCallback((targetTurnIndex: number) => {
    if (!session) return
    const effectiveTarget = targetTurnIndex - 1
    if (effectiveTarget >= session.turns.length - 1 || effectiveTarget < -1) return

    const ops = buildUndoOperations(session.turns, session.turns.length - 1, effectiveTarget)
    setConfirmState({
      type: "undo",
      summary: buildSummary(ops, session.turns.length - 1 - effectiveTarget),
      targetTurnIndex: effectiveTarget,
    })
  }, [session])

  // Request redo: restore the entire most recent branch
  const requestRedoAll = useCallback(() => {
    if (!canRedo || !redoBranch || !session) return

    const ops = buildRedoFromArchived(redoBranch.turns)
    setConfirmState({
      type: "redo",
      summary: buildSummary(ops, redoBranch.turns.length),
      targetTurnIndex: redoBranch.branchPointTurnIndex + redoBranch.turns.length,
      branchId: redoBranch.id,
    })
  }, [canRedo, redoBranch, session])

  // Request partial redo: restore ghost turns up to and including ghostTurnIndex
  const requestRedoUpTo = useCallback((ghostTurnIndex: number) => {
    if (!canRedo || !redoBranch || !session) return

    const turnCount = ghostTurnIndex + 1
    const ops = buildRedoFromArchived(redoBranch.turns, ghostTurnIndex)
    setConfirmState({
      type: "redo",
      summary: buildSummary(ops, turnCount),
      targetTurnIndex: redoBranch.branchPointTurnIndex + turnCount,
      branchId: redoBranch.id,
      redoUpToArchiveIndex: ghostTurnIndex,
    })
  }, [canRedo, redoBranch, session])

  // Request branch switch (from branch modal)
  const requestBranchSwitch = useCallback((branchId: string, archiveTurnIndex?: number) => {
    if (!session) return
    const branch = branches.find((b) => b.id === branchId)
    if (!branch) return

    const targetArchiveIdx = archiveTurnIndex ?? branch.turns.length - 1

    const undoOps = session.turns.length > branch.branchPointTurnIndex + 1
      ? buildUndoOperations(session.turns, session.turns.length - 1, branch.branchPointTurnIndex)
      : []
    const redoOps = buildRedoFromArchived(branch.turns, targetArchiveIdx)

    setConfirmState({
      type: "branch-switch",
      summary: buildSummary([...undoOps, ...redoOps], targetArchiveIdx + 1),
      targetTurnIndex: branch.branchPointTurnIndex,
      branchId,
      branchTurnIndex: targetArchiveIdx,
    })
  }, [session, branches])

  // Confirm and apply the pending operation
  const confirmApply = useCallback(async () => {
    if (!confirmState || !session || !sessionSource) {
      setConfirmState(null)
      return
    }

    setIsApplying(true)
    setApplyError(null)

    try {
      const state = undoState ?? createEmptyUndoState(session.sessionId, session.turns.length)

      // Fetch the current JSONL content from disk. sessionSource.rawText may
      // be stale if SSE streaming added lines after the session was loaded.
      const freshRes = await authFetch(
        `/api/sessions/${encodeURIComponent(sessionSource.dirName)}/${encodeURIComponent(sessionSource.fileName)}`
      )
      if (!freshRes.ok) {
        setApplyError("Failed to read session file")
        return
      }
      const freshRawText = await freshRes.text()

      if (confirmState.type === "undo") {
        await applyUndo(confirmState, session, sessionSource, state, freshRawText, applyOperations, saveUndoState, setApplyError)
      } else if (confirmState.type === "redo") {
        const branch = branches.find((b) => b.id === confirmState.branchId)
        if (!branch) { setConfirmState(null); return }
        await applyRedo(confirmState, sessionSource, state, branch, applyOperations, saveUndoState, setApplyError)
      } else if (confirmState.type === "branch-switch") {
        const branch = branches.find((b) => b.id === confirmState.branchId)
        if (!branch) { setConfirmState(null); return }
        await applyBranchSwitch(session, sessionSource, state, branch, freshRawText, applyOperations, saveUndoState, setApplyError)
      }

      await onReloadSession()
      setConfirmState(null)
    } catch (err) {
      // ApplyAbort is a control-flow sentinel, not a real error
      if (!(err instanceof ApplyAbort)) throw err
    } finally {
      setIsApplying(false)
    }
  }, [confirmState, session, sessionSource, undoState, branches, applyOperations, saveUndoState, onReloadSession])

  const confirmCancel = useCallback(() => {
    setConfirmState(null)
    setApplyError(null)
  }, [])

  return {
    undoState,
    canRedo,
    redoTurnCount,
    redoGhostTurns,
    branches,
    branchesAtTurn,
    requestUndo,
    requestRedoAll,
    requestRedoUpTo,
    requestBranchSwitch,
    confirmState,
    confirmApply,
    confirmCancel,
    isApplying,
    applyError,
  }
}

// ── Extracted confirm-apply helpers ──────────────────────────────────────────
// Each throws on unrecoverable errors; the caller catches via try/finally.

async function tryApplyOps(
  ops: FileOperation[],
  applyOperations: (ops: FileOperation[]) => Promise<boolean>,
): Promise<void> {
  if (ops.length === 0) return
  const success = await applyOperations(ops)
  if (!success) throw new ApplyAbort()
}

async function truncateJsonl(
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

async function appendJsonl(
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

/** Sentinel error to abort confirm-apply without setting an error message. */
class ApplyAbort extends Error { constructor() { super("abort") } }

async function applyUndo(
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

async function applyRedo(
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

async function applyBranchSwitch(
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
