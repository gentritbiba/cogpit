import { useState, useEffect, useCallback, useRef } from "react"
import { authFetch } from "@/lib/auth"
import type { WorktreeInfo } from "../../server/helpers"

const POLL_INTERVAL = 30_000

export function useWorktrees(dirName: string | null) {
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchWorktrees = useCallback(async () => {
    if (!dirName) return
    try {
      setLoading(true)
      const res = await authFetch(`/api/worktrees/${encodeURIComponent(dirName)}`)
      if (res.ok) {
        const data = await res.json()
        setWorktrees(data)
        setError(null)
      } else {
        setError("Failed to fetch worktrees")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setLoading(false)
    }
  }, [dirName])

  useEffect(() => {
    if (!dirName) {
      setWorktrees([])
      setLoading(false)
      return
    }

    fetchWorktrees()
    intervalRef.current = setInterval(fetchWorktrees, POLL_INTERVAL)

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [dirName, fetchWorktrees])

  return { worktrees, loading, error, refetch: fetchWorktrees }
}
