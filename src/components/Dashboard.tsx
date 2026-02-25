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
            {k === "Ctrl" ? (isMac ? "⌘" : "Ctrl") : k}
          </kbd>
        ))}
      </span>
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
  /** dirName of the currently selected project (from URL state) */
  selectedProjectDirName?: string | null
  /** Callback to change the selected project (pushes URL) */
  onSelectProject?: (dirName: string | null) => void
  /** Duplicate a session (full copy) */
  onDuplicateSession?: (dirName: string, fileName: string) => void
  /** Delete a session file */
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

  // Session list state (for when viewing a project)
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [sessionsTotal, setSessionsTotal] = useState(0)
  const [sessionsPage, setSessionsPage] = useState(1)
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [searchFilter, setSearchFilter] = useState("")
  const [fetchError, setFetchError] = useState<string | null>(null)

  // Track which dirName we last loaded sessions for, to avoid re-fetching
  const loadedForDirName = useRef<string | null>(null)

  const fetchData = useCallback(async (isRefresh = false) => {
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
    fetchData()
    const interval = setInterval(() => fetchData(), 10000)
    return () => clearInterval(interval)
  }, [fetchData])

  // Load sessions when selectedProjectDirName changes (from URL or click)
  useEffect(() => {
    if (!selectedProjectDirName) {
      // Going back to projects list — clear session data
      if (loadedForDirName.current) {
        setSessions([])
        setSessionsTotal(0)
        setSessionsPage(1)
        setSearchFilter("")
        loadedForDirName.current = null
      }
      return
    }

    // Already loaded for this project
    if (loadedForDirName.current === selectedProjectDirName) return

    // Fetch sessions for this project
    loadedForDirName.current = selectedProjectDirName
    setSearchFilter("")
    setSessionsLoading(true)
    setSessions([])
    setFetchError(null)
    authFetch(`/api/sessions/${encodeURIComponent(selectedProjectDirName)}?page=1&limit=20`)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load sessions (${res.status})`)
        return res.json()
      })
      .then((data) => {
        setSessions(data.sessions)
        setSessionsTotal(data.total)
        setSessionsPage(1)
      })
      .catch((err) => setFetchError(err instanceof Error ? err.message : "Failed to load sessions"))
      .finally(() => setSessionsLoading(false))
  }, [selectedProjectDirName])

  // Resolve the selected project info from the projects list
  const selectedProject = useMemo(() => {
    if (!selectedProjectDirName) return null
    const found = projects.find((p) => p.dirName === selectedProjectDirName)
    if (found) return found
    // Fallback: minimal info from dirName
    const fallbackPath = dirNameToPath(selectedProjectDirName)
    return {
      dirName: selectedProjectDirName,
      path: fallbackPath,
      shortName: projectName(fallbackPath),
      sessionCount: sessionsTotal,
      lastModified: null,
    }
  }, [selectedProjectDirName, projects, sessionsTotal])

  const handleSelectProject = useCallback((project: ProjectInfo) => {
    onSelectProject?.(project.dirName)
  }, [onSelectProject])

  const handleBack = useCallback(() => {
    onSelectProject?.(null)
  }, [onSelectProject])

  const loadMoreSessions = useCallback(async () => {
    if (!selectedProjectDirName) return
    const nextPage = sessionsPage + 1
    setSessionsLoading(true)
    try {
      const res = await authFetch(`/api/sessions/${encodeURIComponent(selectedProjectDirName)}?page=${nextPage}&limit=20`)
      if (!res.ok) throw new Error(`Failed to load sessions (${res.status})`)
      const data = await res.json()
      setSessions((prev) => [...prev, ...data.sessions])
      setSessionsTotal(data.total)
      setSessionsPage(nextPage)
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "Failed to load more sessions")
    } finally {
      setSessionsLoading(false)
    }
  }, [selectedProjectDirName, sessionsPage])

  // Build a map of active session counts per project for the folder cards
  const activeCountByProject = useMemo(() => {
    const now = Date.now()
    const map: Record<string, number> = {}
    for (const s of activeSessions) {
      const age = now - new Date(s.lastModified).getTime()
      if (age < 2 * 60 * 1000) {
        map[s.dirName] = (map[s.dirName] || 0) + 1
      }
    }
    return map
  }, [activeSessions])

  // Filter projects
  const filteredProjects = useMemo(() => {
    if (!searchFilter) return projects
    const q = searchFilter.toLowerCase()
    return projects.filter(
      (p) => p.path.toLowerCase().includes(q) || p.shortName.toLowerCase().includes(q)
    )
  }, [projects, searchFilter])

  // Filter sessions
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

          {/* Search */}
          <div className="mb-4 relative max-w-sm">
            <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              placeholder="Filter sessions..."
              className="bg-elevation-1 pl-9 h-8 text-sm border-border/50 placeholder:text-muted-foreground"
            />
            {searchFilter && (
              <button
                onClick={() => setSearchFilter("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="size-3" />
              </button>
            )}
          </div>

          {/* Error banner */}
          {fetchError && (
            <div className="mb-4 flex items-center gap-2.5 rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2.5">
              <AlertTriangle className="size-4 text-red-400 shrink-0" />
              <span className="text-sm text-red-400 flex-1">{fetchError}</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2.5 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10"
                onClick={() => {
                  setFetchError(null)
                  loadedForDirName.current = null
                  if (selectedProjectDirName) {
                    // Re-trigger session load by resetting the ref
                    setSessionsLoading(true)
                    setSessions([])
                    authFetch(`/api/sessions/${encodeURIComponent(selectedProjectDirName)}?page=1&limit=20`)
                      .then((res) => {
                        if (!res.ok) throw new Error(`Failed to load sessions (${res.status})`)
                        return res.json()
                      })
                      .then((data) => {
                        loadedForDirName.current = selectedProjectDirName
                        setSessions(data.sessions)
                        setSessionsTotal(data.total)
                        setSessionsPage(1)
                      })
                      .catch((err) => setFetchError(err instanceof Error ? err.message : "Failed to load sessions"))
                      .finally(() => setSessionsLoading(false))
                  }
                }}
              >
                <RefreshCw className="size-3 mr-1" />
                Retry
              </Button>
            </div>
          )}

          {/* Sessions grid */}
          {sessionsLoading && sessions.length === 0 ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="rounded-lg border border-border/40 elevation-1 p-4">
                  <div className="skeleton h-4 w-3/4 rounded mb-3" />
                  <div className="skeleton h-3 w-1/2 rounded mb-4" />
                  <div className="skeleton h-8 w-full rounded mb-3" />
                  <div className="flex gap-3">
                    <div className="skeleton h-3 w-16 rounded" />
                    <div className="skeleton h-3 w-16 rounded" />
                  </div>
                </div>
              ))}
            </div>
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
                  const isLive = s.lastModified
                    ? Date.now() - new Date(s.lastModified).getTime() < 2 * 60 * 1000
                    : false

                  const card = (
                    <button
                      onClick={() => onSelectSession(selectedProject.dirName, s.fileName)}
                      className={cn(
                        "card-glow group relative w-full rounded-lg border elevation-1 p-4 text-left transition-smooth",
                        "hover:bg-elevation-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40",
                        isLive
                          ? "border-l-[3px] border-l-green-500 border-t-border/40 border-r-border/40 border-b-border/40 live-pulse"
                          : "border-border/40"
                      )}
                    >
                      {/* Slug + model */}
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

                      {/* First user message */}
                      {s.firstUserMessage && (
                        <p className="text-[13px] text-muted-foreground mb-2.5 line-clamp-2 leading-relaxed">
                          {truncate(s.firstUserMessage, 120)}
                        </p>
                      )}

                      {/* Bottom stats */}
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

                      {/* Live dot */}
                      {isLive && (
                        <span className="absolute top-3 right-3 flex h-2 w-2">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                          <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
                        </span>
                      )}
                    </button>
                  )

                  if (onDuplicateSession || onDeleteSession) {
                    return (
                      <SessionContextMenu
                        key={s.fileName}
                        sessionLabel={s.slug || s.sessionId.slice(0, 12)}
                        onDuplicate={onDuplicateSession ? () => onDuplicateSession(selectedProject.dirName, s.fileName) : undefined}
                        onDelete={onDeleteSession ? () => {
                          onDeleteSession(selectedProject.dirName, s.fileName)
                          setSessions((prev) => prev.filter((x) => x.fileName !== s.fileName))
                          setSessionsTotal((prev) => prev - 1)
                        } : undefined}
                      >
                        {card}
                      </SessionContextMenu>
                    )
                  }

                  return <div key={s.fileName}>{card}</div>
                })}
              </div>

              {/* Load more */}
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
              onClick={() => fetchData(true)}
              disabled={refreshing}
              aria-label="Refresh projects"
            >
              <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
            </Button>
          </div>

          {/* Search */}
          <div className="mb-4 relative max-w-sm">
            <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              placeholder="Filter projects..."
              className="bg-elevation-1 pl-9 h-8 text-sm border-border/50 placeholder:text-muted-foreground"
            />
            {searchFilter && (
              <button
                onClick={() => setSearchFilter("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="size-3" />
              </button>
            )}
          </div>

          {/* Error banner */}
          {fetchError && !selectedProjectDirName && (
            <div className="mb-4 flex items-center gap-2.5 rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2.5">
              <AlertTriangle className="size-4 text-red-400 shrink-0" />
              <span className="text-sm text-red-400 flex-1">{fetchError}</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2.5 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10"
                onClick={() => { setFetchError(null); fetchData(true) }}
              >
                <RefreshCw className="size-3 mr-1" />
                Retry
              </Button>
            </div>
          )}

          {loading ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="rounded-lg border border-border/40 elevation-1 p-4">
                  <div className="skeleton h-4 w-3/4 rounded mb-3" />
                  <div className="skeleton h-3 w-1/2 rounded mb-4" />
                  <div className="flex gap-3">
                    <div className="skeleton h-3 w-16 rounded" />
                    <div className="skeleton h-3 w-16 rounded" />
                  </div>
                </div>
              ))}
            </div>
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
                    onClick={() => handleSelectProject(project)}
                    className={cn(
                      "card-glow group relative rounded-lg border elevation-1 p-4 text-left transition-smooth",
                      "hover:bg-elevation-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40",
                      activeCount > 0
                        ? "border-l-[3px] border-l-green-500 border-t-border/40 border-r-border/40 border-b-border/40"
                        : "border-border/40"
                    )}
                  >
                    {/* Folder name */}
                    <div className="flex items-center gap-2.5 mb-2">
                      <FolderOpen className="size-4 shrink-0 text-muted-foreground group-hover:text-blue-400 transition-colors" />
                      <span className="text-sm font-medium text-foreground truncate flex-1">
                        {projectName(project.path)}
                      </span>
                      <ChevronRight className="size-3.5 text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
                    </div>

                    {/* Path */}
                    <p className="text-[11px] text-muted-foreground mb-3 truncate font-mono">
                      {shortPath(project.path)}
                    </p>

                    {/* Bottom stats */}
                    <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <FileText className="size-3" />
                        {project.sessionCount} {project.sessionCount === 1 ? "session" : "sessions"}
                      </span>
                      {activeCount > 0 && (
                        <span className="flex items-center gap-1 text-green-400">
                          <span className="relative flex h-1.5 w-1.5">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-green-500" />
                          </span>
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

                    {/* Active indicator */}
                    {activeCount > 0 && (
                      <span className="absolute top-3 right-3 flex h-2 w-2">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
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
            <Shortcut keys={isMac ? ["⌃", "⌘", "T"] : ["Ctrl", "Alt", "T"]} label="Open terminal" />
            <Shortcut keys={isMac ? ["⌃", "⌘", "N"] : ["Ctrl", "Alt", "N"]} label="Switch project" />
            <Shortcut keys={isMac ? ["⌃", "⌘", "S"] : ["Ctrl", "Alt", "S"]} label="Switch theme" />
            <Shortcut keys={["⌃", "Tab"]} label="Recent session (back)" />
            <Shortcut keys={["⌃", "Shift", "Tab"]} label="Recent session (forward)" />
            <Shortcut keys={["Ctrl", "Shift", "↑ / ↓"]} label="Navigate live sessions" />
            <Shortcut keys={["Ctrl", "Shift", "1–9"]} label="Jump to Nth live session" />
            <Shortcut keys={["Ctrl", "Shift", "M"]} label="Toggle voice input" />
            <Shortcut keys={["Esc"]} label="Clear search" />
          </div>
        </div>

      </div>
    </ScrollArea>
  )
})
