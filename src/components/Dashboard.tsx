import { useState, useEffect, useCallback, useMemo, useRef, memo } from "react"
import {
  Cog,
  RefreshCw,
  MessageSquare,
  GitBranch,
  Activity,
  FolderOpen,
  Clock,
  ChevronLeft,
  ChevronRight,
  FileText,
  Plus,
  Loader2,
  Search,
  X,
  AlertTriangle,
  Keyboard,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { SessionContextMenu } from "@/components/SessionContextMenu"
import { cn } from "@/lib/utils"
import { shortenModel, formatRelativeTime, formatFileSize, truncate, shortPath, projectName, dirNameToPath } from "@/lib/format"
import { authFetch } from "@/lib/auth"

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent)
const LIVE_THRESHOLD_MS = 2 * 60 * 1000

function isLive(lastModified: string | null): boolean {
  if (!lastModified) return false
  return Date.now() - new Date(lastModified).getTime() < LIVE_THRESHOLD_MS
}

function Shortcut({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-0.5 shrink-0">
        {keys.map((k, i) => (
          <kbd
            key={i}
            className="inline-flex items-center justify-center rounded border border-border/80 bg-muted/80 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground min-w-[20px]"
          >
            {k === "Ctrl" ? (isMac ? "\u2318" : "Ctrl") : k}
          </kbd>
        ))}
      </span>
    </div>
  )
}

function LiveDot({ size = "md" }: { size?: "sm" | "md" }) {
  const dotSize = size === "sm" ? "h-1.5 w-1.5" : "h-2 w-2"
  const pingSize = size === "sm" ? "h-full w-full" : "h-full w-full"
  return (
    <span className={cn("relative flex", dotSize)}>
      <span className={cn("absolute inline-flex animate-ping rounded-full bg-green-400 opacity-75", pingSize)} />
      <span className={cn("relative inline-flex rounded-full bg-green-500", dotSize)} />
    </span>
  )
}

function SearchInput({ value, onChange, placeholder }: {
  value: string
  onChange: (v: string) => void
  placeholder: string
}) {
  return (
    <div className="mb-4 relative max-w-sm">
      <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="bg-elevation-1 pl-9 h-8 text-sm border-border/50 placeholder:text-muted-foreground"
      />
      {value && (
        <button
          onClick={() => onChange("")}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          aria-label="Clear search"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  )
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mb-4 flex items-center gap-2.5 rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2.5">
      <AlertTriangle className="size-4 text-red-400 shrink-0" />
      <span className="text-sm text-red-400 flex-1">{message}</span>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2.5 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10"
        onClick={onRetry}
      >
        <RefreshCw className="size-3 mr-1" />
        Retry
      </Button>
    </div>
  )
}

function SkeletonCards({ count = 3, includeMessagePlaceholder = false }: {
  count?: number
  includeMessagePlaceholder?: boolean
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-lg border border-border/40 elevation-1 p-4">
          <div className="skeleton h-4 w-3/4 rounded mb-3" />
          <div className="skeleton h-3 w-1/2 rounded mb-4" />
          {includeMessagePlaceholder && <div className="skeleton h-8 w-full rounded mb-3" />}
          <div className="flex gap-3">
            <div className="skeleton h-3 w-16 rounded" />
            <div className="skeleton h-3 w-16 rounded" />
          </div>
        </div>
      ))}
    </div>
  )
}

interface ProjectInfo {
  dirName: string
  path: string
  shortName: string
  sessionCount: number
  lastModified: string | null
}

interface SessionInfo {
  fileName: string
  sessionId: string
  size: number
  lastModified: string | null
  version?: string
  gitBranch?: string
  model?: string
  slug?: string
  cwd?: string
  firstUserMessage?: string
  timestamp?: string
  turnCount?: number
  lineCount?: number
  branchedFrom?: { sessionId: string; turnIndex?: number | null }
}

interface ActiveSessionInfo {
  dirName: string
  projectShortName: string
  fileName: string
  sessionId: string
  slug?: string
  model?: string
  firstUserMessage?: string
  gitBranch?: string
  cwd?: string
  lastModified: string
  turnCount?: number
  size: number
  isActive?: boolean
}

interface DashboardProps {
  onSelectSession: (dirName: string, fileName: string) => void
  onNewSession?: (dirName: string, cwd?: string) => void
  creatingSession?: boolean
  selectedProjectDirName?: string | null
  onSelectProject?: (dirName: string | null) => void
  onDuplicateSession?: (dirName: string, fileName: string) => void
  onDeleteSession?: (dirName: string, fileName: string) => void
}

export const Dashboard = memo(function Dashboard({
  onSelectSession,
  onNewSession,
  creatingSession,
  selectedProjectDirName,
  onSelectProject,
  onDuplicateSession,
  onDeleteSession,
}: DashboardProps) {
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [activeSessions, setActiveSessions] = useState<ActiveSessionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [sessionsTotal, setSessionsTotal] = useState(0)
  const [sessionsPage, setSessionsPage] = useState(1)
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [searchFilter, setSearchFilter] = useState("")
  const [fetchError, setFetchError] = useState<string | null>(null)

  const loadedForDirName = useRef<string | null>(null)

  const fetchDashboard = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    try {
      const [projectsRes, sessionsRes] = await Promise.all([
        authFetch("/api/projects"),
        authFetch("/api/active-sessions"),
      ])
      if (!projectsRes.ok || !sessionsRes.ok) {
        throw new Error("Failed to fetch dashboard data")
      }
      const projectsData = await projectsRes.json()
      const sessionsData = await sessionsRes.json()
      setProjects(Array.isArray(projectsData) ? projectsData : [])
      setActiveSessions(Array.isArray(sessionsData) ? sessionsData : [])
      setFetchError(null)
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "Failed to load data")
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    fetchDashboard()
    const interval = setInterval(() => fetchDashboard(), 10000)
    return () => clearInterval(interval)
  }, [fetchDashboard])

  const fetchSessions = useCallback(async (dirName: string, page = 1, append = false) => {
    setSessionsLoading(true)
    setFetchError(null)
    if (!append) setSessions([])
    try {
      const res = await authFetch(`/api/sessions/${encodeURIComponent(dirName)}?page=${page}&limit=20`)
      if (!res.ok) throw new Error(`Failed to load sessions (${res.status})`)
      const data = await res.json()
      setSessions((prev) => append ? [...prev, ...data.sessions] : data.sessions)
      setSessionsTotal(data.total)
      setSessionsPage(page)
      loadedForDirName.current = dirName
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "Failed to load sessions")
    } finally {
      setSessionsLoading(false)
    }
  }, [])

  // Load sessions when selectedProjectDirName changes
  useEffect(() => {
    if (!selectedProjectDirName) {
      if (loadedForDirName.current) {
        setSessions([])
        setSessionsTotal(0)
        setSessionsPage(1)
        setSearchFilter("")
        loadedForDirName.current = null
      }
      return
    }
    if (loadedForDirName.current === selectedProjectDirName) return
    setSearchFilter("")
    fetchSessions(selectedProjectDirName)
  }, [selectedProjectDirName, fetchSessions])

  const selectedProject = useMemo(() => {
    if (!selectedProjectDirName) return null
    const found = projects.find((p) => p.dirName === selectedProjectDirName)
    if (found) return found
    const fallbackPath = dirNameToPath(selectedProjectDirName)
    return {
      dirName: selectedProjectDirName,
      path: fallbackPath,
      shortName: projectName(fallbackPath),
      sessionCount: sessionsTotal,
      lastModified: null,
    }
  }, [selectedProjectDirName, projects, sessionsTotal])

  const handleBack = useCallback(() => {
    onSelectProject?.(null)
  }, [onSelectProject])

  const loadMoreSessions = useCallback(() => {
    if (!selectedProjectDirName) return
    fetchSessions(selectedProjectDirName, sessionsPage + 1, true)
  }, [selectedProjectDirName, sessionsPage, fetchSessions])

  const activeCountByProject = useMemo(() => {
    const map: Record<string, number> = {}
    for (const s of activeSessions) {
      if (isLive(s.lastModified)) {
        map[s.dirName] = (map[s.dirName] || 0) + 1
      }
    }
    return map
  }, [activeSessions])

  const filteredProjects = useMemo(() => {
    if (!searchFilter) return projects
    const q = searchFilter.toLowerCase()
    return projects.filter(
      (p) => p.path.toLowerCase().includes(q) || p.shortName.toLowerCase().includes(q)
    )
  }, [projects, searchFilter])

  const filteredSessions = useMemo(() => {
    if (!searchFilter) return sessions
    const q = searchFilter.toLowerCase()
    return sessions.filter(
      (s) =>
        s.firstUserMessage?.toLowerCase().includes(q) ||
        s.slug?.toLowerCase().includes(q) ||
        s.model?.toLowerCase().includes(q) ||
        s.sessionId.toLowerCase().includes(q)
    )
  }, [sessions, searchFilter])

  function handleDeleteSession(dirName: string, fileName: string) {
    onDeleteSession?.(dirName, fileName)
    setSessions((prev) => prev.filter((x) => x.fileName !== fileName))
    setSessionsTotal((prev) => prev - 1)
  }

  function wrapWithContextMenu(key: string, label: string, dirName: string, fileName: string, content: React.ReactNode): React.ReactNode {
    if (!onDuplicateSession && !onDeleteSession) {
      return <div key={key}>{content}</div>
    }
    return (
      <SessionContextMenu
        key={key}
        sessionLabel={label}
        onDuplicate={onDuplicateSession ? () => onDuplicateSession(dirName, fileName) : undefined}
        onDelete={onDeleteSession ? () => handleDeleteSession(dirName, fileName) : undefined}
      >
        {content}
      </SessionContextMenu>
    )
  }

  // ── Sessions view (drilled into a project) ──
  if (selectedProject) {
    return (
      <ScrollArea className="h-full">
        <div className="mx-auto max-w-5xl px-6 py-8 fade-in">
          {/* Header with back button */}
          <div className="mb-6">
            <button
              onClick={handleBack}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-3"
            >
              <ChevronLeft className="size-3.5" />
              All Projects
            </button>
            <div className="flex items-center gap-3">
              <FolderOpen className="size-6 text-blue-400" />
              <div className="flex-1 min-w-0">
                <h1 className="text-xl font-bold tracking-tight text-foreground truncate">
                  {projectName(selectedProject.path)}
                </h1>
                <p className="text-xs text-muted-foreground truncate mt-0.5">{shortPath(selectedProject.path)}</p>
              </div>
              {onNewSession && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5 text-xs border-border hover:border-border/80"
                      disabled={creatingSession}
                      onClick={() => onNewSession(selectedProject.dirName, selectedProject.path)}
                    >
                      {creatingSession ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Plus className="size-3.5" />
                      )}
                      New Session
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {creatingSession ? "Creating session..." : `Start a new session in ${projectName(selectedProject.path)}`}
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>

          <SearchInput value={searchFilter} onChange={setSearchFilter} placeholder="Filter sessions..." />

          {fetchError && (
            <ErrorBanner
              message={fetchError}
              onRetry={() => {
                setFetchError(null)
                loadedForDirName.current = null
                if (selectedProjectDirName) {
                  fetchSessions(selectedProjectDirName)
                }
              }}
            />
          )}

          {sessionsLoading && sessions.length === 0 ? (
            <SkeletonCards includeMessagePlaceholder />
          ) : filteredSessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border/40 bg-elevation-1 py-12 px-6 text-center">
              <FileText className="size-8 text-muted-foreground mb-3" />
              <p className="text-sm text-muted-foreground">
                {searchFilter ? "No matching sessions" : "No sessions in this project"}
              </p>
            </div>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {filteredSessions.map((s) => {
                  const live = isLive(s.lastModified)

                  const card = (
                    <button
                      onClick={() => onSelectSession(selectedProject.dirName, s.fileName)}
                      className={cn(
                        "card-glow group relative w-full rounded-lg border elevation-1 p-4 text-left transition-smooth",
                        "hover:bg-elevation-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40",
                        live
                          ? "border-l-[3px] border-l-green-500 border-t-border/40 border-r-border/40 border-b-border/40 live-pulse"
                          : "border-border/40"
                      )}
                    >
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className="text-xs font-medium text-foreground truncate">
                          {s.slug || truncate(s.sessionId, 12)}
                        </span>
                        {s.model && (
                          <Badge variant="secondary" className="h-4 px-1.5 text-[9px] font-normal shrink-0">
                            {shortenModel(s.model)}
                          </Badge>
                        )}
                      </div>

                      {s.firstUserMessage && (
                        <p className="text-[13px] text-muted-foreground mb-2.5 line-clamp-2 leading-relaxed">
                          {truncate(s.firstUserMessage, 120)}
                        </p>
                      )}

                      <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                        {(s.turnCount ?? 0) > 0 && (
                          <span className="flex items-center gap-1">
                            <MessageSquare className="size-3" />
                            {s.turnCount}
                          </span>
                        )}
                        {s.gitBranch && (
                          <span className="flex items-center gap-1 truncate max-w-[100px]">
                            <GitBranch className="size-3 shrink-0" />
                            {truncate(s.gitBranch, 16)}
                          </span>
                        )}
                        <span className="text-[10px]">{formatFileSize(s.size)}</span>
                        {s.lastModified && (
                          <span className="flex items-center gap-1 ml-auto shrink-0">
                            <Clock className="size-3" />
                            {formatRelativeTime(s.lastModified)}
                          </span>
                        )}
                      </div>

                      {live && (
                        <span className="absolute top-3 right-3">
                          <LiveDot />
                        </span>
                      )}
                    </button>
                  )

                  return wrapWithContextMenu(
                    s.fileName,
                    s.slug || s.sessionId.slice(0, 12),
                    selectedProject.dirName,
                    s.fileName,
                    card
                  )
                })}
              </div>

              {sessions.length < sessionsTotal && !searchFilter && (
                <div className="mt-4 text-center">
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs border-border/40 hover:border-border"
                    disabled={sessionsLoading}
                    onClick={loadMoreSessions}
                  >
                    {sessionsLoading ? "Loading..." : "Load more sessions"}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </ScrollArea>
    )
  }

  // ── Projects view (default) ──
  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-5xl px-6 py-8 fade-in">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <Cog className="size-7 text-blue-400" />
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              Cogpit
            </h1>
          </div>
          <p className="text-sm text-muted-foreground">Session Viewer & Monitor</p>
        </div>

        {/* Projects Section */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-4">
            <h2 className="text-sm font-semibold text-foreground uppercase tracking-wider">
              Projects
            </h2>
            <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-medium">
              {projects.length}
            </Badge>
            <div className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
              onClick={() => fetchDashboard(true)}
              disabled={refreshing}
              aria-label="Refresh projects"
            >
              <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
            </Button>
          </div>

          <SearchInput value={searchFilter} onChange={setSearchFilter} placeholder="Filter projects..." />

          {fetchError && !selectedProjectDirName && (
            <ErrorBanner
              message={fetchError}
              onRetry={() => { setFetchError(null); fetchDashboard(true) }}
            />
          )}

          {loading ? (
            <SkeletonCards />
          ) : filteredProjects.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border/40 bg-elevation-1 py-12 px-6 text-center">
              <Activity className="size-8 text-muted-foreground mb-3" />
              <p className="text-sm text-muted-foreground">
                {searchFilter ? "No matching projects" : "No projects found. Start Claude Code to see projects here."}
              </p>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filteredProjects.map((project) => {
                const activeCount = activeCountByProject[project.dirName] || 0

                return (
                  <button
                    key={project.dirName}
                    onClick={() => onSelectProject?.(project.dirName)}
                    className={cn(
                      "card-glow group relative rounded-lg border elevation-1 p-4 text-left transition-smooth",
                      "hover:bg-elevation-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40",
                      activeCount > 0
                        ? "border-l-[3px] border-l-green-500 border-t-border/40 border-r-border/40 border-b-border/40"
                        : "border-border/40"
                    )}
                  >
                    <div className="flex items-center gap-2.5 mb-2">
                      <FolderOpen className="size-4 shrink-0 text-muted-foreground group-hover:text-blue-400 transition-colors" />
                      <span className="text-sm font-medium text-foreground truncate flex-1">
                        {projectName(project.path)}
                      </span>
                      <ChevronRight className="size-3.5 text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
                    </div>

                    <p className="text-[11px] text-muted-foreground mb-3 truncate font-mono">
                      {shortPath(project.path)}
                    </p>

                    <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <FileText className="size-3" />
                        {project.sessionCount} {project.sessionCount === 1 ? "session" : "sessions"}
                      </span>
                      {activeCount > 0 && (
                        <span className="flex items-center gap-1 text-green-400">
                          <LiveDot size="sm" />
                          {activeCount} active
                        </span>
                      )}
                      {project.lastModified && (
                        <span className="flex items-center gap-1 ml-auto shrink-0">
                          <Clock className="size-3" />
                          {formatRelativeTime(project.lastModified)}
                        </span>
                      )}
                    </div>

                    {activeCount > 0 && (
                      <span className="absolute top-3 right-3">
                        <LiveDot />
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Keyboard shortcuts */}
        <div className="mt-6 rounded-lg border border-border/40 bg-elevation-1 px-5 py-4">
          <div className="flex items-center gap-2 mb-3">
            <Keyboard className="size-3.5 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground">Keyboard Shortcuts</span>
          </div>
          <div className="grid grid-cols-2 gap-x-8 gap-y-1.5 text-[11px]">
            <Shortcut keys={["Space"]} label="Focus chat input" />
            <Shortcut keys={["Ctrl", "B"]} label="Toggle sidebar" />
            <Shortcut keys={["Ctrl", "E"]} label="Expand all turns" />
            <Shortcut keys={["Ctrl", "Shift", "E"]} label="Collapse all turns" />
            <Shortcut keys={isMac ? ["\u2303", "\u2318", "T"] : ["Ctrl", "Alt", "T"]} label="Open terminal" />
            <Shortcut keys={isMac ? ["\u2303", "\u2318", "N"] : ["Ctrl", "Alt", "N"]} label="Switch project" />
            <Shortcut keys={isMac ? ["\u2303", "\u2318", "S"] : ["Ctrl", "Alt", "S"]} label="Switch theme" />
            <Shortcut keys={["\u2303", "Tab"]} label="Recent session (back)" />
            <Shortcut keys={["\u2303", "Shift", "Tab"]} label="Recent session (forward)" />
            <Shortcut keys={["Ctrl", "Shift", "\u2191 / \u2193"]} label="Navigate live sessions" />
            <Shortcut keys={["Ctrl", "Shift", "1\u20139"]} label="Jump to Nth live session" />
            <Shortcut keys={["Ctrl", "Shift", "M"]} label="Toggle voice input" />
            <Shortcut keys={["Esc"]} label="Clear search" />
          </div>
        </div>

      </div>
    </ScrollArea>
  )
})
