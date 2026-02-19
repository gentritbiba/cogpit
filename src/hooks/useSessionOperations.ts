import { useState, useCallback } from "react"
import type { ParsedSession } from "@/lib/types"
import type { SessionSource } from "@/hooks/useLiveSession"
import type { SessionAction } from "@/hooks/useSessionState"
import { useUndoRedo } from "@/hooks/useUndoRedo"
import { parseSession } from "@/lib/parser"
import { authFetch } from "@/lib/auth"

interface UseSessionOperationsParams {
  session: ParsedSession | null
  sessionSource: SessionSource | null
  dispatch: React.Dispatch<SessionAction>
  isMobile: boolean
  jumpToTurn: (index: number, toolCallId?: string) => void
}

export function useSessionOperations({
  session,
  sessionSource,
  dispatch,
  isMobile,
  jumpToTurn,
}: UseSessionOperationsParams) {
  // Reload session from server (used after undo/redo JSONL mutations)
  const reloadSession = useCallback(async () => {
    if (!sessionSource) return
    const { dirName, fileName } = sessionSource
    const res = await authFetch(
      `/api/sessions/${encodeURIComponent(dirName)}/${encodeURIComponent(fileName)}`
    )
    if (!res.ok) return
    const rawText = await res.text()
    const newSession = parseSession(rawText)
    dispatch({
      type: "RELOAD_SESSION_CONTENT",
      session: newSession,
      source: { dirName, fileName, rawText },
    })
  }, [sessionSource, dispatch])

  // Undo/redo system
  const undoRedo = useUndoRedo(session, sessionSource, reloadSession)

  // Branch modal state
  const [branchModalTurn, setBranchModalTurn] = useState<number | null>(null)
  const branchModalBranches = branchModalTurn !== null ? undoRedo.branchesAtTurn(branchModalTurn) : []
  const handleOpenBranches = useCallback((turnIndex: number) => setBranchModalTurn(turnIndex), [])
  const handleCloseBranchModal = useCallback(() => setBranchModalTurn(null), [])
  const { requestBranchSwitch } = undoRedo
  const handleRedoToTurn = useCallback((branchId: string, archiveTurnIdx: number) => {
    requestBranchSwitch(branchId, archiveTurnIdx)
    setBranchModalTurn(null)
  }, [requestBranchSwitch])
  const handleRedoEntireBranch = useCallback((branchId: string) => {
    requestBranchSwitch(branchId)
    setBranchModalTurn(null)
  }, [requestBranchSwitch])

  // Duplicate any session by dirName/fileName and load it
  const handleDuplicateSessionByPath = useCallback(async (dirName: string, fileName: string) => {
    try {
      const res = await authFetch("/api/branch-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dirName, fileName }),
      })
      if (!res.ok) return
      const data = await res.json()
      const contentRes = await authFetch(
        `/api/sessions/${encodeURIComponent(data.dirName)}/${encodeURIComponent(data.fileName)}`
      )
      if (!contentRes.ok) return
      const rawText = await contentRes.text()
      const newSession = parseSession(rawText)
      dispatch({
        type: "LOAD_SESSION",
        session: newSession,
        source: { dirName: data.dirName, fileName: data.fileName, rawText },
        isMobile,
      })
    } catch {
      // silently fail
    }
  }, [dispatch, isMobile])

  // Duplicate the current session (full copy)
  const handleDuplicateSession = useCallback(() => {
    if (!sessionSource) return
    handleDuplicateSessionByPath(sessionSource.dirName, sessionSource.fileName)
  }, [sessionSource, handleDuplicateSessionByPath])

  // Delete any session by dirName/fileName
  const handleDeleteSession = useCallback(async (dirName: string, fileName: string) => {
    try {
      await authFetch("/api/delete-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dirName, fileName }),
      })
    } catch {
      // silently fail
    }
  }, [])

  // Duplicate from a specific turn (creates a new session truncated at that turn)
  const handleBranchFromHere = useCallback(async (turnIndex: number) => {
    if (!sessionSource) return
    const { dirName, fileName } = sessionSource
    try {
      const res = await authFetch("/api/branch-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dirName, fileName, turnIndex }),
      })
      if (!res.ok) return
      const data = await res.json()
      const contentRes = await authFetch(
        `/api/sessions/${encodeURIComponent(data.dirName)}/${encodeURIComponent(data.fileName)}`
      )
      if (!contentRes.ok) return
      const rawText = await contentRes.text()
      const newSession = parseSession(rawText)
      dispatch({
        type: "LOAD_SESSION",
        session: newSession,
        source: { dirName: data.dirName, fileName: data.fileName, rawText },
        isMobile,
      })
    } catch {
      // silently fail
    }
  }, [sessionSource, dispatch, isMobile])

  // Mobile StatsPanel jump callback
  const handleMobileJumpToTurn = useCallback((index: number, toolCallId?: string) => {
    jumpToTurn(index, toolCallId)
    dispatch({ type: "SET_MOBILE_TAB", tab: "chat" })
  }, [jumpToTurn, dispatch])

  return {
    reloadSession,
    undoRedo,
    branchModalTurn,
    branchModalBranches,
    handleOpenBranches,
    handleCloseBranchModal,
    handleRedoToTurn,
    handleRedoEntireBranch,
    handleDuplicateSessionByPath,
    handleDuplicateSession,
    handleDeleteSession,
    handleBranchFromHere,
    handleMobileJumpToTurn,
  }
}
