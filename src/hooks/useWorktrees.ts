import { useState, useEffect, useCallback, useRef } from "react"
import { authFetch } from "@/lib/auth"
import type { WorktreeInfo } from "../../shared/contracts/worktrees"

const POLL_INTERVAL = 30_000

interface WorktreeState {
  dirName: string | null
  worktrees: WorktreeInfo[]
  loading: boolean
  error: string | null
}

export function useWorktrees(dirName: string | null) {
  const [state, setState] = useState<WorktreeState>(() => ({
    dirName,
    worktrees: [],
    loading: dirName !== null,
    error: null,
  }))
  const requestSequence = useRef(0)

  const fetchWorktrees = useCallback(async () => {
    if (!dirName) return
    const requestId = ++requestSequence.current
    setState((current) => {
      if (current.dirName === dirName && current.loading) return current
      return {
        dirName,
        worktrees: current.dirName === dirName ? current.worktrees : [],
        loading: true,
        error: current.dirName === dirName ? current.error : null,
      }
    })

    try {
      const res = await authFetch(`/api/worktrees/${encodeURIComponent(dirName)}`)
      if (requestId !== requestSequence.current) return

      if (res.ok) {
        const worktrees = await res.json() as WorktreeInfo[]
        if (requestId !== requestSequence.current) return
        setState({ dirName, worktrees, loading: false, error: null })
        return
      }

      setState((current) => current.dirName === dirName
        ? { ...current, loading: false, error: "Failed to fetch worktrees" }
        : current)
    } catch (err) {
      if (requestId !== requestSequence.current) return
      setState((current) => current.dirName === dirName
        ? {
            ...current,
            loading: false,
            error: err instanceof Error ? err.message : "Unknown error",
          }
        : current)
    }
  }, [dirName])

  useEffect(() => {
    if (!dirName) {
      requestSequence.current += 1
      return
    }

    void fetchWorktrees()
    const interval = setInterval(() => void fetchWorktrees(), POLL_INTERVAL)
    return () => {
      clearInterval(interval)
      requestSequence.current += 1
    }
  }, [dirName, fetchWorktrees])

  const visibleState = state.dirName === dirName
    ? state
    : { dirName, worktrees: [], loading: dirName !== null, error: null }

  return {
    worktrees: visibleState.worktrees,
    loading: visibleState.loading,
    error: visibleState.error,
    refetch: fetchWorktrees,
  }
}
