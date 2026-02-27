import { useState, useCallback, useRef, useEffect, useMemo } from "react"
import type { ParsedSession, UndoState, Branch, Turn } from "@/lib/types"
import type { SessionSource } from "./useLiveSession"
import { parseSession } from "@/lib/parser"
import { authFetch } from "@/lib/auth"
import {
  buildUndoOperations,
  buildRedoFromArchived,
  createEmptyUndoState,
  type FileOperation,
} from "@/lib/undo-engine"
import { buildSummary } from "./undo/undoHelpers"
import {
  ApplyAbort,
  applyUndo,
  applyRedo,
  applyBranchSwitch,
} from "./undo/undoApplyOperations"

// ── Re-exports (preserve public API) ─────────────────────────────────────────

export type { UndoConfirmState } from "./undo/undoHelpers"
export { buildSummary, isTurnStartingUserMessage, findCutoffLine } from "./undo/undoHelpers"
export { ApplyAbort, tryApplyOps, truncateJsonl, appendJsonl, applyUndo, applyRedo, applyBranchSwitch } from "./undo/undoApplyOperations"

const EMPTY_BRANCHES: Branch[] = []

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
  confirmState: import("./undo/undoHelpers").UndoConfirmState | null
  confirmApply: () => Promise<void>
  confirmCancel: () => void

  // Loading
  isApplying: boolean
  applyError: string | null
}

export function useUndoRedo(
  session: ParsedSession | null,
  sessionSource: SessionSource | null,
  onReloadSession: () => Promise<void>,
): UseUndoRedoResult {
  const [undoState, setUndoState] = useState<UndoState | null>(null)
  const [confirmState, setConfirmState] = useState<import("./undo/undoHelpers").UndoConfirmState | null>(null)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-fetch when sessionId changes, not on every session object update
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
