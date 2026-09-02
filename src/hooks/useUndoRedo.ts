import { useState, useCallback, useRef, useEffect, useMemo } from "react"
import type { ParsedSession, UndoState, Branch, Turn } from "../../shared/session/types"
import type { SessionSource } from "./useLiveSession"
import { parseSession } from "../../shared/session/parser"
import { authFetch } from "@/lib/auth"
import { capabilitiesForDirName } from "@/lib/agents"
import { applyNativeRewind, previewNativeRewind } from "@/lib/agents/nativeRewind"
import {
  buildUndoOperations,
  buildRedoFromArchived,
  createEmptyUndoState,
} from "@/lib/undo-engine"
import { buildSummary, type UndoConfirmState } from "./undo/undoHelpers"
import {
  ApplyAbort,
  applyUndo,
  applyRedo,
  applyBranchSwitch,
  type UndoTransaction,
} from "./undo/undoApplyOperations"

export type { UndoConfirmState } from "./undo/undoHelpers"
const EMPTY_BRANCHES: Branch[] = []

export interface UseUndoRedoResult {
  enabled: boolean
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
  confirmApply: (restoreFiles?: boolean) => Promise<void>
  confirmCancel: () => void

  // Loading
  isApplying: boolean
  applyError: string | null
}

export function useUndoRedo(
  session: ParsedSession | null,
  sessionSource: SessionSource | null,
  onReloadSession: () => Promise<void>,
  enabled = true,
): UseUndoRedoResult {
  const [undoState, setUndoState] = useState<UndoState | null>(null)
  const [confirmState, setConfirmState] = useState<UndoConfirmState | null>(null)
  const [isApplying, setIsApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const rewindPreviewRequestRef = useRef(0)

  // Load undo state when session changes
  useEffect(() => {
    rewindPreviewRequestRef.current += 1
    if (!enabled || !session) {
      setUndoState(null)
      setConfirmState(null)
      setApplyError(null)
      sessionIdRef.current = null
      return
    }
    if (session.sessionId === sessionIdRef.current) return
    sessionIdRef.current = session.sessionId

    // No persisted undo history to fetch when the CLI keeps none of its own.
    if (!capabilitiesForDirName(sessionSource?.dirName).redo) {
      setUndoState(null)
      return
    }

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
  }, [enabled, session?.sessionId])

  const commitUndoTransaction = useCallback(async (transaction: UndoTransaction) => {
    try {
      const response = await authFetch("/api/undo/transaction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operations: transaction.operations,
          session: {
            dirName: transaction.sessionSource.dirName,
            fileName: transaction.sessionSource.fileName,
            mutation: transaction.sessionMutation,
          },
          state: transaction.state,
          checkpoint: transaction.checkpoint,
        }),
      })
      const result = await response.json().catch(() => null) as { error?: string } | null
      if (!response.ok) {
        setApplyError(result?.error || "Undo transaction failed")
        throw new ApplyAbort()
      }
      setUndoState(transaction.state)
    } catch (err) {
      if (err instanceof ApplyAbort) throw err
      setApplyError(String(err))
      throw new ApplyAbort()
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
    if (!enabled || !session) return
    const effectiveTarget = targetTurnIndex - 1
    if (effectiveTarget >= session.turns.length - 1 || effectiveTarget < -1) return

    if (capabilitiesForDirName(sessionSource?.dirName).nativeRewind) {
      const turn = session.turns[targetTurnIndex]
      if (!turn) return
      const requestedSessionId = session.sessionId
      const previewRequest = ++rewindPreviewRequestRef.current
      const isCurrentRequest = () => (
        rewindPreviewRequestRef.current === previewRequest
        && sessionIdRef.current === requestedSessionId
      )
      const eventId = turn.id.includes("@") ? turn.id.slice(turn.id.lastIndexOf("@") + 1) : turn.id
      const turnCount = session.turns.length - targetTurnIndex
      void previewNativeRewind(session.sessionId, eventId).then((preview) => {
        if (!isCurrentRequest()) return
        const filePaths = preview?.files
          ?.map(({ path }) => path)
          .filter((path): path is string => typeof path === "string") ?? []
        const fileCount = preview?.available ? preview.fileCount ?? filePaths.length : 0
        setConfirmState({
          type: "undo",
          summary: {
            turnCount,
            fileCount,
            filePaths,
            operationCount: fileCount,
          },
          targetTurnIndex: effectiveTarget,
          nativeRewind: {
            eventId,
            mode: "conversation",
            filesAvailable: Boolean(preview?.available && fileCount > 0),
          },
        })
      }).catch(() => {
        if (!isCurrentRequest()) return
        setConfirmState({
          type: "undo",
          summary: { turnCount, fileCount: 0, filePaths: [], operationCount: 0 },
          targetTurnIndex: effectiveTarget,
          nativeRewind: { eventId, mode: "conversation" },
        })
      })
      return
    }

    const ops = buildUndoOperations(session.turns, session.turns.length - 1, effectiveTarget)
    setConfirmState({
      type: "undo",
      summary: buildSummary(ops, session.turns.length - 1 - effectiveTarget),
      targetTurnIndex: effectiveTarget,
    })
  }, [enabled, session, sessionSource?.dirName])

  // Request redo: restore the entire most recent branch
  const requestRedoAll = useCallback(() => {
    if (!enabled || !canRedo || !redoBranch || !session) return

    const ops = buildRedoFromArchived(redoBranch.turns)
    setConfirmState({
      type: "redo",
      summary: buildSummary(ops, redoBranch.turns.length),
      targetTurnIndex: redoBranch.branchPointTurnIndex + redoBranch.turns.length,
      branchId: redoBranch.id,
    })
  }, [enabled, canRedo, redoBranch, session])

  // Request partial redo: restore ghost turns up to and including ghostTurnIndex
  const requestRedoUpTo = useCallback((ghostTurnIndex: number) => {
    if (!enabled || !canRedo || !redoBranch || !session) return

    const turnCount = ghostTurnIndex + 1
    const ops = buildRedoFromArchived(redoBranch.turns, ghostTurnIndex)
    setConfirmState({
      type: "redo",
      summary: buildSummary(ops, turnCount),
      targetTurnIndex: redoBranch.branchPointTurnIndex + turnCount,
      branchId: redoBranch.id,
      redoUpToArchiveIndex: ghostTurnIndex,
    })
  }, [enabled, canRedo, redoBranch, session])

  // Request branch switch (from branch modal)
  const requestBranchSwitch = useCallback((branchId: string, archiveTurnIndex?: number) => {
    if (!enabled || !session) return
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
  }, [enabled, session, branches])

  // Confirm and apply the pending operation
  const confirmApply = useCallback(async (restoreFiles = false) => {
    if (!enabled || !confirmState || !session || !sessionSource) {
      setConfirmState(null)
      return
    }

    setIsApplying(true)
    setApplyError(null)

    try {
      if (confirmState.nativeRewind) {
        const mode = restoreFiles && confirmState.nativeRewind.filesAvailable
          ? "conversation-and-files"
          : "conversation"
        const outcome = await applyNativeRewind(session.sessionId, confirmState.nativeRewind.eventId, mode)
        if (!outcome.ok) {
          setApplyError(outcome.error)
          return
        }
        await onReloadSession()
        setConfirmState(null)
        return
      }

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
        await applyUndo(confirmState, session, sessionSource, state, freshRawText, commitUndoTransaction, setApplyError)
      } else if (confirmState.type === "redo") {
        const branch = branches.find((b) => b.id === confirmState.branchId)
        if (!branch) { setConfirmState(null); return }
        await applyRedo(confirmState, sessionSource, state, branch, freshRawText, commitUndoTransaction)
      } else if (confirmState.type === "branch-switch") {
        const branch = branches.find((b) => b.id === confirmState.branchId)
        if (!branch) { setConfirmState(null); return }
        await applyBranchSwitch(session, sessionSource, state, branch, freshRawText, confirmState, commitUndoTransaction)
      }

      // Stop the live session so it restarts fresh from the truncated
      // transcript on the next message. Without this, the running process
      // still holds the full (pre-undo) conversation in memory.
      try {
        await authFetch("/api/stop-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: session.sessionId }),
        })
      } catch {
        // Best-effort: session may not have a running process
      }

      await onReloadSession()
      setConfirmState(null)
    } catch (err) {
      // ApplyAbort is a control-flow sentinel, not a real error
      if (!(err instanceof ApplyAbort)) throw err
    } finally {
      setIsApplying(false)
    }
  }, [enabled, confirmState, session, sessionSource, undoState, branches, commitUndoTransaction, onReloadSession])

  const confirmCancel = useCallback(() => {
    rewindPreviewRequestRef.current += 1
    setConfirmState(null)
    setApplyError(null)
  }, [])

  return {
    enabled,
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
