import { useState, useEffect, useCallback, useMemo, useRef, memo } from "react"
import { Loader2, RefreshCw, Activity, X, Search, AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { authFetch } from "@/lib/auth"
import { SessionRow } from "./SessionRow"
import { ProcessList } from "./ProcessList"
import type { ActiveSessionInfo, RunningProcess } from "./SessionRow"

// Re-export extracted modules so external imports remain unchanged
export { SessionRow } from "./SessionRow"
export type { ActiveSessionInfo, RunningProcess } from "./SessionRow"
export { ProcessList } from "./ProcessList"

interface LiveSessionsProps {
  activeSessionKey: string | null
  onSelectSession: (dirName: string, fileName: string) => void
  onDuplicateSession?: (dirName: string, fileName: string) => void
  onDeleteSession?: (dirName: string, fileName: string) => void
}

/** Partition processes into a session-keyed map and an unmatched list. */
function partitionProcesses(processes: RunningProcess[]): {
  procBySession: Map<string, RunningProcess>
  unmatchedProcs: RunningProcess[]
} {
  const procBySession = new Map<string, RunningProcess>()
  const unmatchedProcs: RunningProcess[] = []

  for (const p of processes) {
    if (!p.sessionId) {
      unmatchedProcs.push(p)
      continue
    }
    const existing = procBySession.get(p.sessionId)
    if (!existing || p.memMB > existing.memMB) {
      procBySession.set(p.sessionId, p)
      if (existing) unmatchedProcs.push(existing)
    }
  }

  return { procBySession, unmatchedProcs }
}

export const LiveSessions = memo(function LiveSessions({ activeSessionKey, onSelectSession, onDuplicateSession, onDeleteSession }: LiveSessionsProps) {
  const [sessions, setSessions] = useState<ActiveSessionInfo[]>([])
  const [processes, setProcesses] = useState<RunningProcess[]>([])
  const [loading, setLoading] = useState(false)
  const [killingPids, setKillingPids] = useState<Set<number>>(new Set())
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("")
  const [searching, setSearching] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const debouncedSearchRef = useRef(debouncedSearch)
  debouncedSearchRef.current = debouncedSearch

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 300)
    return () => clearTimeout(timer)
  }, [searchQuery])

  const fetchData = useCallback(async (search?: string) => {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac

    setLoading(true)
    if (search) setSearching(true)
    try {
      const searchParam = search ? `?search=${encodeURIComponent(search)}&limit=50` : ""
      const [sessRes, procRes] = await Promise.all([
        authFetch(`/api/active-sessions${searchParam}`, { signal: ac.signal }),
        authFetch("/api/running-processes", { signal: ac.signal }),
      ])
      if (ac.signal.aborted) return
      if (!sessRes.ok || !procRes.ok) {
        throw new Error("Failed to fetch live data")
      }
      const [sessData, procData] = await Promise.all([
        sessRes.json(),
        procRes.json(),
      ])
      if (ac.signal.aborted) return
      setSessions(sessData)
      setProcesses(procData)
      setFetchError(null)
    } catch (err) {
      if (ac.signal.aborted) return
      setFetchError(err instanceof Error ? err.message : "Failed to load data")
    } finally {
      if (!ac.signal.aborted) {
        setLoading(false)
        setSearching(false)
      }
    }
  }, [])

  useEffect(() => {
    fetchData(debouncedSearch || undefined)
  }, [debouncedSearch, fetchData])

  useEffect(() => {
    const interval = setInterval(() => fetchData(debouncedSearchRef.current || undefined), 10000)
    return () => clearInterval(interval)
  }, [fetchData])

  const { procBySession, unmatchedProcs } = useMemo(
    () => partitionProcesses(processes),
    [processes]
  )

  const handleKill = useCallback(async (pid: number, e: React.MouseEvent) => {
    e.stopPropagation()
    setKillingPids(prev => new Set(prev).add(pid))
    try {
      await authFetch("/api/kill-process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pid }),
      })
      setTimeout(() => fetchData(debouncedSearchRef.current || undefined), 1500)
    } catch { /* ignore */ }
    setTimeout(() => {
      setKillingPids(prev => {
        const next = new Set(prev)
        next.delete(pid)
        return next
      })
    }, 2000)
  }, [fetchData])

  function handleDeleteSession(s: ActiveSessionInfo) {
    onDeleteSession?.(s.dirName, s.fileName)
    setSessions((prev) => prev.filter((x) => x.sessionId !== s.sessionId))
  }

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 flex items-center justify-between px-3 py-2">
        <span className="text-xs font-medium text-foreground flex items-center gap-1.5">
          <Activity className="size-3" />
          Live & Recent
        </span>
        <div className="flex items-center gap-1">
          {processes.length > 0 && (
            <span className="text-[10px] text-muted-foreground mr-1">
              {processes.length} proc{processes.length !== 1 ? "s" : ""}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={() => fetchData(debouncedSearch || undefined)}
            aria-label="Refresh live sessions"
          >
            <RefreshCw
              className={cn("size-3", loading && "animate-spin")}
            />
          </Button>
        </div>
      </div>

      {/* Search bar */}
      <div className="shrink-0 px-2 pb-2 pt-1">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search sessions & prompts\u2026"
            className="w-full rounded-lg border border-border/60 elevation-2 depth-low py-2 pl-8 pr-8 text-xs text-foreground placeholder:text-muted-foreground focus:border-blue-500/40 focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-colors"
          />
          {searchQuery && !searching && (
            <button
              onClick={() => { setSearchQuery(""); searchInputRef.current?.focus() }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          )}
          {searching && (
            <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 size-3 animate-spin text-muted-foreground" />
          )}
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-1.5 px-2 pt-1 pb-3">
          {fetchError && (
            <div className="mx-2 mb-1 flex items-center gap-2 rounded-md border border-red-900/50 bg-red-950/30 px-2 py-1.5">
              <AlertTriangle className="size-3 text-red-400 shrink-0" />
              <span className="text-[10px] text-red-400 flex-1 truncate">{fetchError}</span>
              <button
                onClick={() => { setFetchError(null); fetchData(debouncedSearchRef.current || undefined) }}
                className="text-[10px] text-red-400 hover:text-red-300 shrink-0"
              >
                Retry
              </button>
            </div>
          )}

          {sessions.length === 0 && unmatchedProcs.length === 0 && !loading && !fetchError && (
            <div className="px-3 py-8 text-center">
              {debouncedSearch ? (
                <>
                  <Search className="size-5 mx-auto mb-2 text-muted-foreground" />
                  <p className="text-xs text-muted-foreground">No sessions match &quot;{debouncedSearch}&quot;</p>
                  <p className="text-[10px] text-muted-foreground mt-1">Try a different search term</p>
                </>
              ) : (
                <>
                  <Activity className="size-5 mx-auto mb-2 text-muted-foreground" />
                  <p className="text-xs text-muted-foreground">No active sessions</p>
                  <p className="text-[10px] text-muted-foreground mt-1">Start Claude Code to see sessions here</p>
                </>
              )}
            </div>
          )}

          {loading && sessions.length === 0 && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {sessions.map((s) => (
            <SessionRow
              key={`${s.dirName}/${s.fileName}`}
              session={s}
              isActiveSession={activeSessionKey === `${s.dirName}/${s.fileName}`}
              proc={procBySession.get(s.sessionId)}
              killingPids={killingPids}
              onSelectSession={onSelectSession}
              onKill={handleKill}
              onDuplicateSession={onDuplicateSession}
              onDeleteSession={onDeleteSession ? handleDeleteSession : undefined}
            />
          ))}

          {/* Unmatched processes */}
          <ProcessList
            unmatchedProcs={unmatchedProcs}
            killingPids={killingPids}
            onKill={handleKill}
          />
        </div>
      </ScrollArea>
    </div>
  )
})
