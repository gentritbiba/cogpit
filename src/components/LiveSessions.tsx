import { useState, useEffect, useCallback, memo } from "react"
import { Loader2, RefreshCw, GitBranch, MessageSquare, Activity, X, Cpu, HardDrive, AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { authFetch } from "@/lib/auth"
import {
  formatFileSize,
  formatRelativeTime,
  truncate,
} from "@/lib/format"

interface ActiveSessionInfo {
  dirName: string
  projectShortName: string
  fileName: string
  sessionId: string
  slug?: string
  firstUserMessage?: string
  lastUserMessage?: string
  gitBranch?: string
  cwd?: string
  lastModified: string
  turnCount?: number
  size: number
  isActive?: boolean
}

interface RunningProcess {
  pid: number
  memMB: number
  cpu: number
  sessionId: string | null
  tty: string
  args: string
  startTime: string
}

interface LiveSessionsProps {
  activeSessionKey: string | null
  onSelectSession: (dirName: string, fileName: string) => void
}

export const LiveSessions = memo(function LiveSessions({ activeSessionKey, onSelectSession }: LiveSessionsProps) {
  const [sessions, setSessions] = useState<ActiveSessionInfo[]>([])
  const [processes, setProcesses] = useState<RunningProcess[]>([])
  const [loading, setLoading] = useState(false)
  const [killingPids, setKillingPids] = useState<Set<number>>(new Set())
  const [fetchError, setFetchError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const [sessRes, procRes] = await Promise.all([
        authFetch("/api/active-sessions"),
        authFetch("/api/running-processes"),
      ])
      if (!sessRes.ok || !procRes.ok) {
        throw new Error("Failed to fetch live data")
      }
      const [sessData, procData] = await Promise.all([
        sessRes.json(),
        procRes.json(),
      ])
      setSessions(sessData)
      setProcesses(procData)
      setFetchError(null)
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "Failed to load data")
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial fetch + poll every 10s
  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 10000)
    return () => clearInterval(interval)
  }, [fetchData])

  // Build a map: sessionId -> process info
  const procBySession = new Map<string, RunningProcess>()
  // Processes not linked to any session (interactive terminals, orphans)
  const unmatchedProcs: RunningProcess[] = []

  for (const p of processes) {
    if (p.sessionId) {
      // If multiple processes share a session ID, keep the largest (main one)
      const existing = procBySession.get(p.sessionId)
      if (!existing || p.memMB > existing.memMB) {
        procBySession.set(p.sessionId, p)
        if (existing) unmatchedProcs.push(existing)
      }
    } else {
      unmatchedProcs.push(p)
    }
  }

  // Sessions that have a running process
  const matchedSessionIds = new Set(procBySession.keys())

  const handleKill = useCallback(async (pid: number, e: React.MouseEvent) => {
    e.stopPropagation()
    setKillingPids(prev => new Set(prev).add(pid))
    try {
      await authFetch("/api/kill-process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pid }),
      })
      // Refresh after a short delay to let process die
      setTimeout(fetchData, 1500)
    } catch { /* ignore */ }
    setTimeout(() => {
      setKillingPids(prev => {
        const next = new Set(prev)
        next.delete(pid)
        return next
      })
    }, 2000)
  }, [fetchData])

  // Describe a process in a short human-readable way
  function describeProcess(p: RunningProcess): string {
    if (p.args.includes("--continue")) return "interactive (--continue)"
    if (p.args.includes("--resume")) return "resumed session"
    if (p.args.includes("stream-json")) return "persistent (Cogpit)"
    if (p.args.includes("-p ")) {
      const msgMatch = p.args.match(/-p\s+(.{1,60})/)
      return msgMatch?.[1] ? `one-shot: "${truncate(msgMatch[1], 40)}"` : "one-shot (-p)"
    }
    return "interactive"
  }

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 flex items-center justify-between px-3 py-2">
        <span className="text-xs font-medium text-zinc-300 flex items-center gap-1.5">
          <Activity className="size-3" />
          Live & Recent
        </span>
        <div className="flex items-center gap-1">
          {processes.length > 0 && (
            <span className="text-[10px] text-zinc-500 mr-1">
              {processes.length} proc{processes.length !== 1 ? "s" : ""}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={fetchData}
            aria-label="Refresh live sessions"
          >
            <RefreshCw
              className={cn("size-3", loading && "animate-spin")}
            />
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-0.5 px-2 pb-3">
          {fetchError && (
            <div className="mx-2 mb-1 flex items-center gap-2 rounded-md border border-red-900/50 bg-red-950/30 px-2 py-1.5">
              <AlertTriangle className="size-3 text-red-400 shrink-0" />
              <span className="text-[10px] text-red-400 flex-1 truncate">{fetchError}</span>
              <button
                onClick={() => { setFetchError(null); fetchData() }}
                className="text-[10px] text-red-400 hover:text-red-300 shrink-0"
              >
                Retry
              </button>
            </div>
          )}

          {sessions.length === 0 && unmatchedProcs.length === 0 && !loading && !fetchError && (
            <div className="px-3 py-8 text-center">
              <Activity className="size-5 mx-auto mb-2 text-zinc-700" />
              <p className="text-xs text-zinc-600">No active sessions</p>
              <p className="text-[10px] text-zinc-700 mt-1">Start Claude Code to see sessions here</p>
            </div>
          )}

          {loading && sessions.length === 0 && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-5 animate-spin text-zinc-500" />
            </div>
          )}

          {sessions.map((s) => {
            const isActiveSession =
              activeSessionKey === `${s.dirName}/${s.fileName}`
            const proc = procBySession.get(s.sessionId)
            const hasProcess = matchedSessionIds.has(s.sessionId)

            return (
              <button
                key={`${s.dirName}/${s.fileName}`}
                data-live-session
                onClick={() => onSelectSession(s.dirName, s.fileName)}
                className={cn(
                  "group flex flex-col gap-1 rounded-lg px-2.5 py-2.5 text-left transition-all duration-150 border border-transparent hover:border-zinc-800",
                  isActiveSession
                    ? "border-l-2 border-l-blue-500 bg-blue-500/5"
                    : hasProcess
                      ? "border-l-2 border-l-green-500 hover:bg-zinc-900"
                      : "border-l-2 border-l-zinc-700/50 hover:bg-zinc-900"
                )}
              >
                {/* Top row: status dot + last prompt + kill button */}
                <div className="flex items-center gap-2">
                  <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    {hasProcess ? (
                      <>
                        <span className="absolute inline-flex h-2.5 w-2.5 animate-ping rounded-full bg-green-400 opacity-75" />
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
                      </>
                    ) : (
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-zinc-600" />
                    )}
                  </span>
                  <span className="text-xs font-medium text-zinc-300 truncate flex-1">
                    {s.lastUserMessage || s.firstUserMessage || s.slug || truncate(s.sessionId, 16)}
                  </span>
                  {hasProcess && proc ? (
                    <button
                      onClick={(e) => handleKill(proc.pid, e)}
                      disabled={killingPids.has(proc.pid)}
                      className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity rounded p-0.5 hover:bg-red-500/20 text-zinc-500 hover:text-red-400 disabled:opacity-50"
                      title={`Kill PID ${proc.pid} (${proc.memMB} MB)`}
                      aria-label={`Kill process ${proc.pid}`}
                    >
                      <X className="size-3" />
                    </button>
                  ) : (
                    <span className="font-mono text-xs text-zinc-500 shrink-0">
                      #{s.sessionId.slice(0, 5)}
                    </span>
                  )}
                </div>

                {/* Project name */}
                <div className="ml-5.5 text-[10px] text-zinc-600">
                  {s.projectShortName}
                </div>

                {/* Meta row */}
                <div className="ml-5.5 flex items-center gap-2 text-[10px] text-zinc-600 flex-wrap">
                  {(s.turnCount ?? 0) > 0 && (
                    <span className="flex items-center gap-0.5">
                      <MessageSquare className="size-2.5" />
                      {s.turnCount}
                    </span>
                  )}
                  {s.gitBranch && (
                    <span className="flex items-center gap-0.5">
                      <GitBranch className="size-2.5" />
                      {s.gitBranch}
                    </span>
                  )}
                  <span>{formatFileSize(s.size)}</span>
                  <span>{formatRelativeTime(s.lastModified)}</span>
                  {hasProcess && proc && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="flex items-center gap-0.5 text-green-500">
                          <Cpu className="size-2.5" />
                          {proc.memMB} MB
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>RAM usage for this session</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </button>
            )
          })}

          {/* Unmatched processes — running claude instances without a known session */}
          {unmatchedProcs.length > 0 && (
            <>
              <div className="px-2.5 pt-3 pb-1">
                <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider">
                  Running Processes ({unmatchedProcs.length})
                </span>
              </div>
              {unmatchedProcs.map((p) => (
                <div
                  key={p.pid}
                  className="group flex items-center gap-2 rounded-lg px-2.5 py-2 border border-transparent hover:border-zinc-800 hover:bg-zinc-900"
                >
                  <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-zinc-300 truncate">
                      {describeProcess(p)}
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-zinc-600">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="flex items-center gap-0.5">
                            <HardDrive className="size-2.5" />
                            {p.memMB} MB
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>RAM usage for this process</TooltipContent>
                      </Tooltip>
                      <span>PID {p.pid}</span>
                      <span>{p.tty !== "??" ? p.tty : "bg"}</span>
                      <span>{p.startTime}</span>
                    </div>
                  </div>
                  <button
                    onClick={(e) => handleKill(p.pid, e)}
                    disabled={killingPids.has(p.pid)}
                    className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity rounded p-1 hover:bg-red-500/20 text-zinc-500 hover:text-red-400 disabled:opacity-50"
                    title={`Kill PID ${p.pid}`}
                    aria-label={`Kill process ${p.pid}`}
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  )
})
