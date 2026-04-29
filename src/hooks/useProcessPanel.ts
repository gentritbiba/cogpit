import { useState, useEffect, useRef, useCallback } from "react"

// ── Types ────────────────────────────────────────────────────────────────────

export interface ProcessEntry {
  id: string
  name: string
  type: "script" | "task" | "terminal"
  status: "running" | "stopped" | "errored"
  source?: string
  /** For task type: path to .output file (SSE via /api/task-output) */
  outputPath?: string
}

interface PanelCache {
  activeId: string | null
  collapsed: boolean
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useProcessPanel(sessionId: string | null | undefined) {
  const [processes, setProcesses] = useState<Map<string, ProcessEntry>>(new Map())
  const [activeProcessId, setActiveProcessId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(true)
  const cacheRef = useRef<Map<string, PanelCache>>(new Map())
  const prevSessionIdRef = useRef<string | null>(null)

  // Save/restore state when switching sessions
  useEffect(() => {
    const currentId = sessionId ?? null
    const prevId = prevSessionIdRef.current
    if (prevId && prevId !== currentId) {
      cacheRef.current.set(prevId, {
        activeId: activeProcessId,
        collapsed,
      })
    }
    if (currentId !== prevId) {
      const cached = currentId ? cacheRef.current.get(currentId) : null
      if (cached) {
        setActiveProcessId(cached.activeId)
        setCollapsed(cached.collapsed)
      } else {
        setActiveProcessId(null)
        setCollapsed(true)
      }
    }
    prevSessionIdRef.current = currentId
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const toggleCollapse = useCallback(() => setCollapsed((p) => !p), [])

  const addProcess = useCallback((entry: ProcessEntry) => {
    setProcesses((prev) => {
      const next = new Map(prev)
      next.set(entry.id, entry)
      return next
    })
    setActiveProcessId(entry.id)
    setCollapsed(false)
  }, [])

  const removeProcess = useCallback((id: string) => {
    setProcesses((prev) => {
      const next = new Map(prev)
      next.delete(id)

      // If the removed process was active, switch to the last remaining
      setActiveProcessId((prevActive) => {
        if (prevActive !== id) return prevActive
        const remaining = [...next.keys()]
        return remaining.length > 0 ? remaining[remaining.length - 1] : null
      })

      return next
    })
  }, [])

  const setActive = useCallback((id: string) => {
    setActiveProcessId(id)
    setCollapsed(false)
  }, [])

  const updateProcessStatus = useCallback((id: string, status: ProcessEntry["status"]) => {
    setProcesses((prev) => {
      const entry = prev.get(id)
      if (!entry || entry.status === status) return prev
      const next = new Map(prev)
      next.set(id, { ...entry, status })
      return next
    })
  }, [])

  // Bridge: handle servers discovered by BackgroundServers component (type='task')
  const handleServersChanged = useCallback((servers: { id: string; outputPath: string; title: string }[]) => {
    setProcesses((prev) => {
      let changed = false
      const next = new Map(prev)
      const serverIds = new Set(servers.map((s) => s.id))

      // Remove old task entries that are no longer present
      for (const [id, entry] of next) {
        if (entry.type === "task" && !serverIds.has(id)) {
          next.delete(id)
          changed = true
        }
      }

      // Add/update task entries
      for (const s of servers) {
        const existing = next.get(s.id)
        if (!existing) {
          next.set(s.id, {
            id: s.id,
            name: s.title,
            type: "task",
            status: "running",
            outputPath: s.outputPath,
          })
          changed = true
        } else if (existing.name !== s.title || existing.outputPath !== s.outputPath) {
          next.set(s.id, { ...existing, name: s.title, outputPath: s.outputPath })
          changed = true
        }
      }

      return changed ? next : prev
    })
  }, [])

  // Bridge: handle toggle from BackgroundServers/StatsPanel click
  const handleToggleServer = useCallback((id: string, outputPath?: string, title?: string) => {
    if (outputPath && title) {
      setProcesses((prev) => {
        if (prev.has(id)) return prev
        const next = new Map(prev)
        next.set(id, {
          id,
          name: title,
          type: "task",
          status: "running",
          outputPath,
        })
        return next
      })
    }

    setActiveProcessId((prev) => {
      if (prev === id) {
        // Toggle off — just collapse
        setCollapsed(true)
        return prev
      }
      setCollapsed(false)
      return id
    })
  }, [])

  return {
    processes,
    activeProcessId,
    collapsed,
    toggleCollapse,
    addProcess,
    removeProcess,
    setActive,
    updateProcessStatus,
    handleServersChanged,
    handleToggleServer,
  }
}
