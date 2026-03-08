import { useState, useEffect, useCallback, useRef } from "react"
import { authFetch } from "@/lib/auth"

export interface McpServer {
  name: string
  status: "connected" | "needs_auth" | "error"
}

const STORAGE_PREFIX = "cogpit:mcpSelection:"

function loadSavedSelection(dirName: string): string[] | null {
  try {
    const stored = localStorage.getItem(STORAGE_PREFIX + dirName)
    if (stored) return JSON.parse(stored)
  } catch { /* ignore */ }
  return null
}

function saveSelection(dirName: string, selected: string[]) {
  try {
    localStorage.setItem(STORAGE_PREFIX + dirName, JSON.stringify(selected))
  } catch { /* ignore */ }
}

export function useMcpServers(cwd: string | undefined, dirName: string | undefined) {
  const [servers, setServers] = useState<McpServer[]>([])
  const [selectedServers, setSelectedServers] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const dirNameRef = useRef(dirName)
  dirNameRef.current = dirName

  // Fetch servers from backend
  useEffect(() => {
    if (!cwd) return
    setLoading(true)

    authFetch(`/api/mcp-servers?cwd=${encodeURIComponent(cwd)}`)
      .then(async (res) => {
        if (!res.ok) return
        const data = await res.json()
        const fetched: McpServer[] = data.servers ?? []
        setServers(fetched)

        // Initialize selection: use saved prefs or auto-select connected
        const saved = dirNameRef.current ? loadSavedSelection(dirNameRef.current) : null
        if (saved) {
          // Filter saved to only include servers that still exist and are connected
          const connectedNames = new Set(fetched.filter(s => s.status === "connected").map(s => s.name))
          setSelectedServers(saved.filter(name => connectedNames.has(name)))
        } else {
          setSelectedServers(fetched.filter(s => s.status === "connected").map(s => s.name))
        }
      })
      .catch(() => { /* ignore */ })
      .finally(() => setLoading(false))
  }, [cwd])

  const toggleServer = useCallback((name: string) => {
    setSelectedServers(prev => {
      const next = prev.includes(name)
        ? prev.filter(n => n !== name)
        : [...prev, name]
      if (dirNameRef.current) saveSelection(dirNameRef.current, next)
      return next
    })
  }, [])

  const refresh = useCallback(() => {
    if (!cwd) return
    setLoading(true)
    authFetch(`/api/mcp-servers?cwd=${encodeURIComponent(cwd)}&refresh=1`)
      .then(async (res) => {
        if (!res.ok) return
        const data = await res.json()
        setServers(data.servers ?? [])
      })
      .catch(() => { /* ignore */ })
      .finally(() => setLoading(false))
  }, [cwd])

  // Compute disallowed tools for unselected connected servers
  const disallowedMcpTools = servers
    .filter(s => s.status === "connected" && !selectedServers.includes(s.name))
    .map(s => `mcp__${s.name}__*`)

  return {
    servers,
    selectedServers,
    disallowedMcpTools,
    loading,
    toggleServer,
    refresh,
  }
}
