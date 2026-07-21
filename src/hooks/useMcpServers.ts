import { useState, useEffect, useCallback, useRef, useMemo } from "react"
import { authFetch } from "@/lib/auth"
import { fetchSessionConfig, saveSessionConfig } from "@/lib/sessionConfig"

export interface McpServer {
  name: string
  status: "connected" | "needs_auth" | "error"
}

type McpConfigs = Record<string, Record<string, unknown>>

interface McpResponse {
  servers: McpServer[]
  configs: McpConfigs
}

/** Extract the set of connected server names from a server list. */
function connectedNames(servers: McpServer[]): Set<string> {
  return new Set(servers.filter(s => s.status === "connected").map(s => s.name))
}

// Selections live in the server-side session config store, so every Cogpit
// client (any browser or device) sees the same per-session MCP state, and
// remote devices are inherently scoped to their own server.
async function loadSavedSelection(key: string): Promise<string[] | null> {
  const config = await fetchSessionConfig(key)
  return Array.isArray(config?.mcpServers) ? config.mcpServers : null
}

function saveSelection(key: string, selected: string[]): void {
  saveSessionConfig(key, { mcpServers: selected })
}

async function parseServerResponse(res: Response): Promise<McpResponse | null> {
  if (!res.ok) return null
  const data = await res.json()
  return {
    servers: data.servers ?? [],
    configs: data.configs ?? {},
  }
}

async function fetchServerResponse(url: string, signal: AbortSignal): Promise<McpResponse | null> {
  try {
    const response = await authFetch(url, { signal })
    if (signal.aborted) return null
    const parsed = await parseServerResponse(response)
    return signal.aborted ? null : parsed
  } catch {
    return null
  }
}

/**
 * Resolve the initial selection for a given storage key and server list.
 * Tries session-specific key first, then project-level fallback, then auto-selects all connected.
 */
async function resolveSelection(
  storageKey: string | null,
  dirName: string | undefined,
  servers: McpServer[],
): Promise<string[]> {
  const connected = connectedNames(servers)
  if (connected.size === 0) return []

  // Try session-specific saved selection
  if (storageKey) {
    const saved = await loadSavedSelection(storageKey)
    if (saved) {
      return saved.filter(name => connected.has(name))
    }
  }

  // Try project-level fallback (when storageKey is session-specific)
  if (dirName && storageKey !== dirName) {
    const projectSaved = await loadSavedSelection(dirName)
    if (projectSaved) {
      return projectSaved.filter(name => connected.has(name))
    }
  }

  // No saved selection anywhere — auto-select all connected
  return [...connected]
}

/**
 * @param cwd - Project working directory (used to fetch MCP server list)
 * @param dirName - Project dirName (used as fallback storage key for new sessions)
 * @param sessionFileName - Current session fileName (used as per-session storage key)
 */
export function useMcpServers(
  cwd: string | undefined,
  dirName: string | undefined,
  sessionFileName: string | undefined,
) {
  const [servers, setServers] = useState<McpServer[]>([])
  const [configs, setConfigs] = useState<McpConfigs>({})
  const [selectedServers, setSelectedServers] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const refreshRequestRef = useRef<AbortController | null>(null)
  const dirNameRef = useRef(dirName)
  dirNameRef.current = dirName

  // Per-session storage key, falling back to project-level for new sessions
  const storageKey = sessionFileName ?? dirName ?? null
  const storageKeyRef = useRef(storageKey)
  storageKeyRef.current = storageKey

  // Track the cwd that was last fetched so we can detect stale data
  const fetchedCwdRef = useRef<string | undefined>(undefined)

  // Fetch servers from backend when cwd changes
  useEffect(() => {
    if (!cwd) return
    const controller = new AbortController()
    refreshRequestRef.current?.abort()

    // Reset state immediately to prevent stale data from old project showing
    setServers([])
    setConfigs({})
    setSelectedServers([])
    setLoading(true)
    setLoaded(false)
    fetchedCwdRef.current = cwd

    void fetchServerResponse(
      `/api/mcp-servers?cwd=${encodeURIComponent(cwd)}`,
      controller.signal,
    ).then(async (parsed) => {
        if (controller.signal.aborted || fetchedCwdRef.current !== cwd || !parsed) return

        setServers(parsed.servers)
        setConfigs(parsed.configs)
        const selection = await resolveSelection(storageKeyRef.current, dirNameRef.current, parsed.servers)
        if (controller.signal.aborted || fetchedCwdRef.current !== cwd) return
        setSelectedServers(selection)
      })
      .finally(() => {
        if (controller.signal.aborted || fetchedCwdRef.current !== cwd) return
        setLoading(false)
        setLoaded(true)
      })
    return () => controller.abort()
  }, [cwd])

  useEffect(() => () => refreshRequestRef.current?.abort(), [])

  // When session changes (storageKey changes), reload that session's saved MCP selection.
  // This handles switching between sessions within the same project (cwd stays the same).
  // The cwd effect handles project switches (which also resets everything).
  useEffect(() => {
    // Skip if no servers loaded yet — the cwd effect handles initial selection
    if (servers.length === 0) return
    // Skip if no storageKey
    if (!storageKey) return

    let cancelled = false
    void resolveSelection(storageKey, dirName, servers).then((selection) => {
      if (cancelled || storageKeyRef.current !== storageKey) return
      setSelectedServers(selection)
    })
    return () => { cancelled = true }
  }, [storageKey]) // eslint-disable-line react-hooks/exhaustive-deps
  // Intentionally exclude `servers` and `dirName` — we only want this to fire
  // on session switches, NOT when servers change (that's handled by the cwd effect).

  const toggleServer = useCallback((name: string) => {
    setSelectedServers(prev => {
      const next = prev.includes(name)
        ? prev.filter(n => n !== name)
        : [...prev, name]
      if (storageKeyRef.current) saveSelection(storageKeyRef.current, next)
      return next
    })
  }, [])

  const refresh = useCallback(() => {
    if (!cwd) return
    refreshRequestRef.current?.abort()
    const controller = new AbortController()
    refreshRequestRef.current = controller
    setLoading(true)
    void fetchServerResponse(
      `/api/mcp-servers?cwd=${encodeURIComponent(cwd)}&refresh=1`,
      controller.signal,
    ).then((parsed) => {
        if (controller.signal.aborted || fetchedCwdRef.current !== cwd || !parsed) return

        setServers(parsed.servers)
        setConfigs(parsed.configs)

        // Reconcile: keep previously selected servers that are still connected.
        // Do NOT auto-select newly connected servers — let the user opt in.
        const connected = connectedNames(parsed.servers)
        setSelectedServers(prev => {
          const next = prev.filter(name => connected.has(name))
          if (storageKeyRef.current) saveSelection(storageKeyRef.current, next)
          return next
        })
      })
      .finally(() => {
        if (controller.signal.aborted || refreshRequestRef.current !== controller) return
        setLoading(false)
      })
  }, [cwd])

  // Compute MCP config JSON for --strict-mcp-config --mcp-config
  // null = use default config (all servers), string = only load these servers
  const mcpConfigJson = useMemo((): string | null => {
    if (servers.length === 0) return null

    const connected = connectedNames(servers)
    const allSelected = selectedServers.length === connected.size &&
      connected.size > 0 &&
      selectedServers.every(name => connected.has(name))
    if (allSelected) return null

    // Every selected server must have a known config for strict mode.
    // If any config is missing, fall back to null (all servers loaded) to avoid
    // accidentally excluding a server the user thinks is selected.
    if (!selectedServers.every(name => configs[name])) return null

    const selectedConfigs = Object.fromEntries(
      selectedServers.map(name => [name, configs[name]])
    )
    return JSON.stringify({ mcpServers: selectedConfigs })
  }, [selectedServers, configs, servers])

  return {
    servers,
    selectedServers,
    mcpConfigJson,
    loading,
    loaded,
    toggleServer,
    refresh,
  }
}
