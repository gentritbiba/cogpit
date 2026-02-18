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

/**
 * Find the JSONL line index where turn `keepTurnCount` ends.
 * Parses JSONL lines directly (robust against skipped lines in rawMessages).
 */
function findCutoffLine(allLines: string[], keepTurnCount: number): number {
  let userMsgCount = 0
  for (let i = 0; i < allLines.length; i++) {
    try {
      const obj = JSON.parse(allLines[i])
      if (obj.type === "user" && !obj.isMeta) {
        // Skip tool_result user messages — the parser attaches those to the
        // current turn rather than starting a new one.
        const content = obj.message?.content
        if (Array.isArray(content) && content.some((b: { type: string }) => b.type === "tool_result")) {
          continue
        }
        userMsgCount++
        if (userMsgCount > keepTurnCount) {
          return i
        }
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
    if (effectiveTarget >= session.turns.length - 1) return
    if (effectiveTarget < -1) return

    const ops = buildUndoOperations(session.turns, session.turns.length - 1, effectiveTarget)
    const archivedCount = session.turns.length - 1 - effectiveTarget

    setConfirmState({
      type: "undo",
      summary: ops.length > 0
        ? summarizeOperations(ops)
        : { turnCount: archivedCount, fileCount: 0, filePaths: [], operationCount: 0 },
      targetTurnIndex: effectiveTarget,
    })
  }, [session])

  // Request redo: restore the entire most recent branch
  const requestRedoAll = useCallback(() => {
    if (!canRedo || !redoBranch || !session) return

    const ops = buildRedoFromArchived(redoBranch.turns)
    setConfirmState({
      type: "redo",
      summary: ops.length > 0
        ? summarizeOperations(ops)
        : { turnCount: redoBranch.turns.length, fileCount: 0, filePaths: [], operationCount: 0 },
      targetTurnIndex: redoBranch.branchPointTurnIndex + redoBranch.turns.length,
      branchId: redoBranch.id,
    })
  }, [canRedo, redoBranch, session])

  // Request partial redo: restore ghost turns up to and including ghostTurnIndex
  const requestRedoUpTo = useCallback((ghostTurnIndex: number) => {
    if (!canRedo || !redoBranch || !session) return

    const upToIdx = ghostTurnIndex
    const ops = buildRedoFromArchived(redoBranch.turns, upToIdx)
    const turnCount = upToIdx + 1
    setConfirmState({
      type: "redo",
      summary: ops.length > 0
        ? summarizeOperations(ops)
        : { turnCount, fileCount: 0, filePaths: [], operationCount: 0 },
      targetTurnIndex: redoBranch.branchPointTurnIndex + turnCount,
      branchId: redoBranch.id,
      redoUpToArchiveIndex: upToIdx,
    })
  }, [canRedo, redoBranch, session])

  // Request branch switch (from branch modal)
  const requestBranchSwitch = useCallback((branchId: string, archiveTurnIndex?: number) => {
    if (!session) return
    const branch = branches.find((b) => b.id === branchId)
    if (!branch) return

    const targetArchiveIdx = archiveTurnIndex ?? branch.turns.length - 1

    // Need to undo current turns past the branch point first
    let undoOps: FileOperation[] = []
    if (session.turns.length > branch.branchPointTurnIndex + 1) {
      undoOps = buildUndoOperations(
        session.turns,
        session.turns.length - 1,
        branch.branchPointTurnIndex,
      )
    }

    const redoOps = buildRedoFromArchived(branch.turns, targetArchiveIdx)
    const allOps = [...undoOps, ...redoOps]

    setConfirmState({
      type: "branch-switch",
      summary: allOps.length > 0
        ? summarizeOperations(allOps)
        : { turnCount: targetArchiveIdx + 1, fileCount: 0, filePaths: [], operationCount: 0 },
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
        const effectiveTarget = confirmState.targetTurnIndex
        const currentIdx = session.turns.length - 1

        // TODO: If file revert succeeds but JSONL truncation fails, we're in a
        // half-applied state. Consider reordering (truncate first) or adding rollback.
        // 1. Revert file changes
        const ops = buildUndoOperations(session.turns, currentIdx, effectiveTarget)
        if (ops.length > 0) {
          const success = await applyOperations(ops)
          if (!success) return
        }

        // 2. Archive undone turns + truncate JSONL
        const keepTurnCount = effectiveTarget + 1
        const allLines = freshRawText.split("\n").filter(Boolean)
        const cutoffLine = findCutoffLine(allLines, keepTurnCount)
        const removedJsonlLines = allLines.slice(cutoffLine)

        if (removedJsonlLines.length > 0) {
          // Scoop up branches that would be orphaned (their branchPoint > effectiveTarget)
          const { retained, scooped } = collectChildBranches(state.branches, effectiveTarget)
          const branch = createBranch(session.turns, effectiveTarget, removedJsonlLines, scooped)

          const truncRes = await authFetch("/api/undo/truncate-jsonl", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              dirName: sessionSource.dirName,
              fileName: sessionSource.fileName,
              keepLines: cutoffLine,
            }),
          })
          if (!truncRes.ok) {
            setApplyError("Failed to truncate session file")
            return
          }

          const newState: UndoState = {
            ...state,
            currentTurnIndex: effectiveTarget,
            totalTurns: keepTurnCount,
            branches: [...retained, branch],
            activeBranchId: null,
          }
          await saveUndoState(newState)
        }

        await onReloadSession()

      } else if (confirmState.type === "redo") {
        const branch = branches.find((b) => b.id === confirmState.branchId)
        if (!branch) { setConfirmState(null); return }

        const isPartial = confirmState.redoUpToArchiveIndex !== undefined
          && confirmState.redoUpToArchiveIndex < branch.turns.length - 1
        const upToIdx = confirmState.redoUpToArchiveIndex ?? branch.turns.length - 1
        const redoTurnCount = upToIdx + 1

        // 1. Apply file changes from branch (partial or full)
        const ops = buildRedoFromArchived(branch.turns, upToIdx)
        if (ops.length > 0) {
          const success = await applyOperations(ops)
          if (!success) return
        }

        // 2. Determine which JSONL lines to append
        let linesToAppend: string[]
        let remainingLines: string[]
        if (isPartial) {
          const cutoff = findCutoffLine(branch.jsonlLines, redoTurnCount)
          linesToAppend = branch.jsonlLines.slice(0, cutoff)
          remainingLines = branch.jsonlLines.slice(cutoff)
        } else {
          linesToAppend = branch.jsonlLines
          remainingLines = []
        }

        if (linesToAppend.length > 0) {
          const appendRes = await authFetch("/api/undo/append-jsonl", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              dirName: sessionSource.dirName,
              fileName: sessionSource.fileName,
              lines: linesToAppend,
            }),
          })
          if (!appendRes.ok) {
            setApplyError("Failed to append session data")
            return
          }
        }

        // 3. Update state — restore child branches that are now in range
        const children = branch.childBranches ?? []
        let newBranches: Branch[]
        if (isPartial && remainingLines.length > 0) {
          // Split children: some can be restored, rest stay with the branch
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
          // Full redo: remove branch, restore all its children
          newBranches = [
            ...state.branches.filter((b) => b.id !== branch.id),
            ...children,
          ]
        }

        const newState: UndoState = {
          ...state,
          currentTurnIndex: state.currentTurnIndex + redoTurnCount,
          totalTurns: state.totalTurns + redoTurnCount,
          branches: newBranches,
          activeBranchId: null,
        }
        await saveUndoState(newState)
        await onReloadSession()

      } else if (confirmState.type === "branch-switch") {
        const branch = branches.find((b) => b.id === confirmState.branchId)
        if (!branch) { setConfirmState(null); return }

        let updatedBranches = [...state.branches]

        // If we have turns past the branch point, undo + archive them first
        if (session.turns.length > branch.branchPointTurnIndex + 1) {
          const undoOps = buildUndoOperations(
            session.turns,
            session.turns.length - 1,
            branch.branchPointTurnIndex,
          )
          if (undoOps.length > 0) {
            const success = await applyOperations(undoOps)
            if (!success) return
          }

          // Scoop up branches that would be orphaned by this undo
          const { retained, scooped } = collectChildBranches(
            updatedBranches, branch.branchPointTurnIndex
          )
          updatedBranches = retained

          // Archive current turns into a new branch (with scooped children)
          const keepTurnCount = branch.branchPointTurnIndex + 1
          const allLines = freshRawText.split("\n").filter(Boolean)
          const cutoffLine = findCutoffLine(allLines, keepTurnCount)
          const removedJsonlLines = allLines.slice(cutoffLine)

          if (removedJsonlLines.length > 0) {
            const currentBranch = createBranch(
              session.turns,
              branch.branchPointTurnIndex,
              removedJsonlLines,
              scooped,
            )
            updatedBranches = [...updatedBranches, currentBranch]

            const truncRes = await authFetch("/api/undo/truncate-jsonl", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                dirName: sessionSource.dirName,
                fileName: sessionSource.fileName,
                keepLines: cutoffLine,
              }),
            })
            if (!truncRes.ok) {
              setApplyError("Failed to truncate session file")
              return
            }
          }
        }

        // Apply target branch's file changes
        const redoOps = buildRedoFromArchived(branch.turns)
        if (redoOps.length > 0) {
          const success = await applyOperations(redoOps)
          if (!success) return
        }

        // Append target branch's JSONL lines
        if (branch.jsonlLines.length > 0) {
          const appendRes = await authFetch("/api/undo/append-jsonl", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              dirName: sessionSource.dirName,
              fileName: sessionSource.fileName,
              lines: branch.jsonlLines,
            }),
          })
          if (!appendRes.ok) {
            setApplyError("Failed to append session data")
            return
          }
        }

        // Save state: remove consumed branch, restore its children
        const restoredChildren = branch.childBranches ?? []
        const newState: UndoState = {
          ...state,
          currentTurnIndex: branch.branchPointTurnIndex + branch.turns.length,
          totalTurns: branch.branchPointTurnIndex + 1 + branch.turns.length,
          branches: [
            ...updatedBranches.filter((b) => b.id !== branch.id),
            ...restoredChildren,
          ],
          activeBranchId: null,
        }
        await saveUndoState(newState)
        await onReloadSession()
      }

      setConfirmState(null)
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
