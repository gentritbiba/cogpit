import { useState, useEffect, useRef, useCallback } from "react"

export function useServerPanel(sessionId: string | null | undefined) {
  const [serverMap, setServerMap] = useState<Map<string, { outputPath: string; title: string }>>(new Map())
  const [visibleServerIds, setVisibleServerIds] = useState<Set<string>>(new Set())
  const [serverPanelCollapsed, setServerPanelCollapsed] = useState(false)
  const serverStateCacheRef = useRef<Map<string, { visibleIds: string[]; collapsed: boolean }>>(new Map())
  const prevSessionIdRef = useRef<string | null>(null)

  // Save/restore server panel state when switching sessions
  useEffect(() => {
    const currentId = sessionId ?? null
    const prevId = prevSessionIdRef.current
    if (prevId && prevId !== currentId) {
      serverStateCacheRef.current.set(prevId, {
        visibleIds: [...visibleServerIds],
        collapsed: serverPanelCollapsed,
      })
    }
    if (currentId !== prevId) {
      const cached = currentId ? serverStateCacheRef.current.get(currentId) : null
      if (cached) {
        setVisibleServerIds(new Set(cached.visibleIds))
        setServerPanelCollapsed(cached.collapsed)
      } else {
        setVisibleServerIds(new Set())
        setServerPanelCollapsed(false)
      }
    }
    prevSessionIdRef.current = currentId
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only run on session switch, reads current state via closure
  }, [sessionId])

  const handleToggleServerCollapse = useCallback(() => setServerPanelCollapsed((p) => !p), [])

  const handleServersChanged = useCallback((servers: { id: string; outputPath: string; title: string }[]) => {
    setServerMap((prev) => {
      const next = new Map<string, { outputPath: string; title: string }>()
      for (const s of servers) {
        next.set(s.id, { outputPath: s.outputPath, title: s.title })
      }
      if (next.size === prev.size) {
        let same = true
        for (const [k, v] of next) {
          const p = prev.get(k)
          if (!p || p.outputPath !== v.outputPath || p.title !== v.title) {
            same = false
            break
          }
        }
        if (same) return prev
      }
      return next
    })
    // Clean up visibleIds for servers that no longer exist.
    if (servers.length > 0) {
      const currentIds = new Set(servers.map((s) => s.id))
      setVisibleServerIds((prev) => {
        const next = new Set([...prev].filter((id) => currentIds.has(id)))
        if (next.size === prev.size) return prev
        return next
      })
    }
  }, [])

  const handleToggleServer = useCallback((id: string, outputPath?: string, title?: string) => {
    if (outputPath && title) {
      setServerMap((prev) => {
        if (prev.has(id)) return prev
        const next = new Map(prev)
        next.set(id, { outputPath, title })
        return next
      })
    }
    setVisibleServerIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
        setServerPanelCollapsed(false)
      }
      return next
    })
  }, [])

  return {
    serverMap,
    visibleServerIds,
    serverPanelCollapsed,
    handleToggleServerCollapse,
    handleServersChanged,
    handleToggleServer,
  }
}
