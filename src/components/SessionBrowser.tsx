import { useState, useEffect, useCallback, useMemo, memo } from "react"
import {
  FileText,
  Wrench,
  Clock,
  AlertTriangle,
  MessageSquare,
  ChevronRight,
  ChevronLeft,
  GitBranch,
  FolderOpen,
  Cpu,
  Hash,
  Zap,
  Search,
  RefreshCw,
  Users,
  X,
  Brain,
  ArrowDownLeft,
  ArrowUpRight,
  Plus,
  Loader2,
  DollarSign,
  Copy,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip"
import { SessionContextMenu } from "@/components/SessionContextMenu"
import { cn } from "@/lib/utils"
import { parseSession } from "@/lib/parser"
import { authFetch } from "@/lib/auth"
import type { ParsedSession } from "@/lib/types"
import {
  shortenModel,
  formatDuration,
  formatTokenCount,
  formatFileSize,
  formatRelativeTime,
  formatCost,
  truncate,
  shortPath,
  projectName,
} from "@/lib/format"

// ── API types ──────────────────────────────────────────────────────────────

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

import { LiveSessions } from "@/components/LiveSessions"
import { TeamsList } from "@/components/TeamsList"

// ── Props ──────────────────────────────────────────────────────────────────

interface SessionBrowserProps {
  session: ParsedSession | null
  /** "dirName/fileName" key identifying the currently loaded session */
  activeSessionKey: string | null
  onLoadSession: (
    session: ParsedSession,
    source: { dirName: string; fileName: string; rawText: string }
  ) => void
  sidebarTab: "browse" | "teams"
  onSidebarTabChange: (tab: "browse" | "teams") => void
  onSelectTeam?: (teamName: string) => void
  /** Create a new Claude session in the given project */
  onNewSession?: (dirName: string) => void
  /** True while a new session is being created */
  creatingSession?: boolean
  /** When true, renders full-width mobile layout */
  isMobile?: boolean
  /** When true, only show the Teams tab (used for mobile teams tab) */
  teamsOnly?: boolean
  /** Duplicate a session (full copy) */
  onDuplicateSession?: (dirName: string, fileName: string) => void
  /** Delete a session file */
  onDeleteSession?: (dirName: string, fileName: string) => void
}

// ── Main Component ─────────────────────────────────────────────────────────

type View = "projects" | "sessions" | "detail"

export const SessionBrowser = memo(function SessionBrowser({
  session,
  activeSessionKey,
  onLoadSession,
  sidebarTab,
  onSidebarTabChange,
  onSelectTeam,
  onNewSession,
  creatingSession,
  isMobile,
  teamsOnly,
  onDuplicateSession,
  onDeleteSession,
}: SessionBrowserProps) {
  const [view, setView] = useState<View>(session ? "detail" : "projects")
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [sessionsTotal, setSessionsTotal] = useState(0)
  const [sessionsPage, setSessionsPage] = useState(1)
  const [selectedProject, setSelectedProject] = useState<ProjectInfo | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [searchFilter, setSearchFilter] = useState("")
  const [fetchError, setFetchError] = useState<string | null>(null)

  // Load projects on mount
  useEffect(() => {
    loadProjects()
  }, [])

  // When session changes externally, switch to detail view
  const sessionId = session?.sessionId ?? null
  useEffect(() => {
    if (sessionId) setView("detail")
  }, [sessionId])

  const loadProjects = useCallback(async () => {
    setIsLoading(true)
    setFetchError(null)
    try {
      const res = await authFetch("/api/projects")
      if (!res.ok) throw new Error(`Failed to load projects (${res.status})`)
      const data = await res.json()
      setProjects(data)
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "Failed to load projects")
    } finally {
      setIsLoading(false)
    }
  }, [])

  const loadSessions = useCallback(async (project: ProjectInfo, page = 1, append = false) => {
    setIsLoading(true)
    setFetchError(null)
    if (!append) {
      setSelectedProject(project)
    }
    try {
      const res = await authFetch(`/api/sessions/${encodeURIComponent(project.dirName)}?page=${page}&limit=20`)
      if (!res.ok) throw new Error(`Failed to load sessions (${res.status})`)
      const data = await res.json()
      if (append) {
        setSessions((prev) => [...prev, ...data.sessions])
      } else {
        setSessions(data.sessions)
      }
      setSessionsTotal(data.total)
      setSessionsPage(page)
      if (!append) setView("sessions")
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "Failed to load sessions")
    } finally {
      setIsLoading(false)
    }
  }, [])

  const loadSessionFile = useCallback(
    async (project: ProjectInfo, session: SessionInfo) => {
      setIsLoading(true)
      setFetchError(null)
      try {
        const res = await authFetch(
          `/api/sessions/${encodeURIComponent(project.dirName)}/${encodeURIComponent(session.fileName)}`
        )
        if (!res.ok) throw new Error(`Failed to load session (${res.status})`)
        const text = await res.text()
        const parsed = parseSession(text)
        onLoadSession(parsed, {
          dirName: project.dirName,
          fileName: session.fileName,
          rawText: text,
        })
        setView("detail")
      } catch (err) {
        setFetchError(err instanceof Error ? err.message : "Failed to load session")
      } finally {
        setIsLoading(false)
      }
    },
    [onLoadSession]
  )

  const loadLiveSession = useCallback(
    async (dirName: string, fileName: string) => {
      setIsLoading(true)
      setFetchError(null)
      try {
        const res = await authFetch(
          `/api/sessions/${encodeURIComponent(dirName)}/${encodeURIComponent(fileName)}`
        )
        if (!res.ok) throw new Error(`Failed to load session (${res.status})`)
        const text = await res.text()
        const parsed = parseSession(text)
        onLoadSession(parsed, { dirName, fileName, rawText: text })
        setView("detail")
      } catch (err) {
        setFetchError(err instanceof Error ? err.message : "Failed to load session")
      } finally {
        setIsLoading(false)
      }
    },
    [onLoadSession]
  )

  const handleBack = useCallback(() => {
    if (view === "detail" && selectedProject) {
      setView("sessions")
    } else if (view === "detail") {
      setView("projects")
    } else if (view === "sessions") {
      setView("projects")
      setSelectedProject(null)
      setSessions([])
      setSessionsTotal(0)
      setSessionsPage(1)
    }
    setSearchFilter("")
  }, [view, selectedProject])

  const handleSelectSession = useCallback(
    (s: SessionInfo) => {
      if (selectedProject) loadSessionFile(selectedProject, s)
    },
    [selectedProject, loadSessionFile]
  )

  const handleDeleteSessionLocal = useCallback(
    (s: SessionInfo) => {
      if (!selectedProject || !onDeleteSession) return
      onDeleteSession(selectedProject.dirName, s.fileName)
      // Remove from local state immediately
      setSessions((prev) => prev.filter((x) => x.fileName !== s.fileName))
      setSessionsTotal((prev) => prev - 1)
    },
    [selectedProject, onDeleteSession]
  )

  const handleDuplicateSessionLocal = useCallback(
    (s: SessionInfo) => {
      if (!selectedProject || !onDuplicateSession) return
      onDuplicateSession(selectedProject.dirName, s.fileName)
    },
    [selectedProject, onDuplicateSession]
  )

  const handleLoadMoreSessions = useCallback(() => {
    if (selectedProject) loadSessions(selectedProject, sessionsPage + 1, true)
  }, [selectedProject, sessionsPage, loadSessions])

  // Mobile teams-only mode: just show the teams list
  if (teamsOnly) {
    return (
      <div className="flex h-full w-full flex-col bg-zinc-950">
        <TeamsList
          onSelectTeam={(teamName) => onSelectTeam?.(teamName)}
        />
      </div>
    )
  }

  return (
    <aside className={cn(
      "flex h-full shrink-0 flex-col bg-zinc-950",
      isMobile ? "w-full" : "w-80 border-r border-zinc-800 panel-enter"
    )} aria-label="Session browser">
      {/* ── Top: Live Sessions ── */}
      <div className="flex min-h-0 flex-[55_1_0%] flex-col overflow-hidden">
        <LiveSessions
          activeSessionKey={activeSessionKey}
          onSelectSession={loadLiveSession}
          onDuplicateSession={onDuplicateSession}
          onDeleteSession={onDeleteSession}
        />
      </div>

      {/* ── Bottom: Browse / Teams ── */}
      <div className="flex min-h-0 flex-[45_1_0%] flex-col overflow-hidden border-t border-zinc-800">
        {/* Tab bar */}
        <div className="flex shrink-0 border-b border-zinc-800" role="tablist">
          <button
            role="tab"
            aria-selected={sidebarTab === "browse"}
            onClick={() => onSidebarTabChange("browse")}
            className={cn(
              "flex-1 text-xs font-medium transition-colors border-b-2",
              isMobile ? "py-3" : "py-2",
              sidebarTab === "browse"
                ? "border-blue-500 text-zinc-200"
                : "border-transparent text-zinc-500 hover:text-zinc-400"
            )}
          >
            Browse
          </button>
          <button
            role="tab"
            aria-selected={sidebarTab === "teams"}
            onClick={() => onSidebarTabChange("teams")}
            className={cn(
              "flex-1 text-xs font-medium transition-colors border-b-2 flex items-center justify-center gap-1.5",
              isMobile ? "py-3" : "py-2",
              sidebarTab === "teams"
                ? "border-blue-500 text-zinc-200"
                : "border-transparent text-zinc-500 hover:text-zinc-400"
            )}
          >
            <Users className="size-3" />
            Teams
          </button>
        </div>

        {/* Browse tab */}
        {sidebarTab === "browse" && (
          <div className="flex flex-1 min-h-0 flex-col">
            {/* Fixed header */}
            <div className={cn(
              "flex shrink-0 items-center gap-2 border-b border-zinc-800 px-3",
              isMobile ? "py-2.5" : "py-2"
            )}>
              {view !== "projects" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn(isMobile ? "h-8 w-8 p-0" : "h-6 w-6 p-0")}
                  onClick={handleBack}
                  aria-label="Go back"
                >
                  <ChevronLeft className={cn(isMobile ? "size-5" : "size-4")} />
                </Button>
              )}
              <span className={cn(
                "font-medium text-zinc-400 truncate flex-1",
                isMobile ? "text-sm" : "text-xs"
              )}>
                {view === "projects" && "Projects"}
                {view === "sessions" && selectedProject && projectName(selectedProject.path)}
                {view === "detail" && "Session"}
              </span>
              {view === "projects" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn(isMobile ? "h-8 w-8 p-0" : "h-6 w-6 p-0")}
                  onClick={loadProjects}
                  aria-label="Refresh projects"
                >
                  <RefreshCw className={cn("size-3", isLoading && "animate-spin")} />
                </Button>
              )}
              {view === "sessions" && selectedProject && onNewSession && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={cn(isMobile ? "h-8 w-8 p-0" : "h-6 w-6 p-0")}
                      disabled={creatingSession}
                      onClick={() => onNewSession(selectedProject.dirName)}
                    >
                      {creatingSession
                        ? <Loader2 className={cn(isMobile ? "size-4" : "size-3.5", "animate-spin")} />
                        : <Plus className={cn(isMobile ? "size-4" : "size-3.5")} />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{creatingSession ? "Creating session..." : `New session in ${projectName(selectedProject.path)}`}</TooltipContent>
                </Tooltip>
              )}
            </div>

            {/* Fixed search (hidden in detail view) */}
            {view !== "detail" && <div className="shrink-0 px-3 py-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-zinc-600" />
                <Input
                  value={searchFilter}
                  onChange={(e) => setSearchFilter(e.target.value)}
                  placeholder={view === "projects" ? "Filter projects..." : "Filter sessions..."}
                  className={cn(
                    "bg-zinc-900 pl-8 border-zinc-800 placeholder:text-zinc-600",
                    isMobile ? "h-9 text-sm" : "h-7 text-xs",
                    searchFilter && "pr-8"
                  )}
                />
                {searchFilter && (
                  <button
                    onClick={() => setSearchFilter("")}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                    aria-label="Clear search"
                  >
                    <X className="size-3" />
                  </button>
                )}
              </div>
            </div>}

            {/* Error banner */}
            {fetchError && (
              <div className="shrink-0 mx-3 mb-1 flex items-center gap-2 rounded-md border border-red-900/50 bg-red-950/30 px-2.5 py-1.5">
                <AlertTriangle className="size-3 text-red-400 shrink-0" />
                <span className="text-[11px] text-red-400 flex-1 truncate">{fetchError}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1.5 text-[10px] text-red-400 hover:text-red-300 hover:bg-red-500/10"
                  onClick={() => {
                    setFetchError(null)
                    if (view === "projects") loadProjects()
                    else if (view === "sessions" && selectedProject) loadSessions(selectedProject)
                  }}
                >
                  <RefreshCw className="size-2.5 mr-1" />
                  Retry
                </Button>
              </div>
            )}

            {/* Scrollable content area */}
            <div className="flex-1 min-h-0">
              {view === "projects" && (
                <ProjectsList
                  projects={projects}
                  filter={searchFilter}
                  onSelectProject={loadSessions}
                  isMobile={isMobile}
                />
              )}
              {view === "sessions" && selectedProject && (
                <SessionsList
                  sessions={sessions}
                  filter={searchFilter}
                  onSelectSession={handleSelectSession}
                  onDuplicateSession={onDuplicateSession ? handleDuplicateSessionLocal : undefined}
                  onDeleteSession={onDeleteSession ? handleDeleteSessionLocal : undefined}
                  isMobile={isMobile}
                  hasMore={sessions.length < sessionsTotal}
                  isLoading={isLoading}
                  onLoadMore={handleLoadMoreSessions}
                />
              )}
              {view === "detail" && session && !isMobile && (
                <SessionDetail session={session} />
              )}
              {view === "detail" && session && isMobile && (
                <div className="flex flex-col items-center justify-center gap-3 py-12 px-6 text-center">
                  <MessageSquare className="size-8 text-zinc-600" />
                  <p className="text-sm text-zinc-400">
                    Session loaded: <span className="font-medium text-zinc-300">{session.slug || session.sessionId.slice(0, 12)}</span>
                  </p>
                  <p className="text-xs text-zinc-600">
                    Tap the Chat tab below to view the conversation
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Teams tab */}
        {sidebarTab === "teams" && (
          <div className="flex-1 min-h-0">
            <TeamsList
              onSelectTeam={(teamName) => onSelectTeam?.(teamName)}
            />
          </div>
        )}
      </div>
    </aside>
  )
})

// ── Projects List ──────────────────────────────────────────────────────────

const ProjectsList = memo(function ProjectsList({
  projects,
  filter,
  onSelectProject,
  isMobile,
}: {
  projects: ProjectInfo[]
  filter: string
  onSelectProject: (p: ProjectInfo) => void
  isMobile?: boolean
}) {
  const filtered = useMemo(() => {
    if (!filter) return projects
    const q = filter.toLowerCase()
    return projects.filter(
      (p) =>
        p.path.toLowerCase().includes(q) ||
        p.shortName.toLowerCase().includes(q)
    )
  }, [projects, filter])

  if (filtered.length === 0) {
    return (
      <div className="px-3 py-8 text-center text-xs text-zinc-600">
        {filter ? "No matching projects" : "No projects found"}
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-0.5 px-2 pb-3">
        {filtered.map((project) => (
          <button
            key={project.dirName}
            onClick={() => onSelectProject(project)}
            className={cn(
              "group flex flex-col gap-1 rounded-lg px-2.5 text-left transition-all hover:bg-zinc-900 border-l-2 border-transparent hover:border-l-blue-500/50",
              isMobile ? "py-3 min-h-[44px]" : "py-2"
            )}
          >
            <div className="flex items-center gap-2">
              <FolderOpen className="size-3.5 shrink-0 text-zinc-500 group-hover:text-blue-400" />
              <span className="text-xs font-medium text-zinc-300 truncate">
                {shortPath(project.path, 2)}
              </span>
              <ChevronRight className="size-3 ml-auto shrink-0 text-zinc-700 group-hover:text-zinc-500" />
            </div>
            <div className="ml-5.5 flex items-center gap-2 text-[10px] text-zinc-600">
              <Badge
                variant="secondary"
                className="h-4 px-1 text-[10px] font-normal"
              >
                {project.sessionCount} sessions
              </Badge>
              {project.lastModified && (
                <span>{formatRelativeTime(project.lastModified)}</span>
              )}
            </div>
          </button>
        ))}
      </div>
    </ScrollArea>
  )
})

// ── Sessions List ──────────────────────────────────────────────────────────

const SessionsList = memo(function SessionsList({
  sessions,
  filter,
  onSelectSession,
  onDuplicateSession,
  onDeleteSession,
  isMobile,
  hasMore,
  isLoading,
  onLoadMore,
}: {
  sessions: SessionInfo[]
  filter: string
  onSelectSession: (s: SessionInfo) => void
  onDuplicateSession?: (s: SessionInfo) => void
  onDeleteSession?: (s: SessionInfo) => void
  isMobile?: boolean
  hasMore?: boolean
  isLoading?: boolean
  onLoadMore?: () => void
}) {
  const filtered = useMemo(() => {
    if (!filter) return sessions
    const q = filter.toLowerCase()
    return sessions.filter(
      (s) =>
        (s.firstUserMessage?.toLowerCase().includes(q)) ||
        (s.slug?.toLowerCase().includes(q)) ||
        (s.model?.toLowerCase().includes(q)) ||
        s.sessionId.toLowerCase().includes(q)
    )
  }, [sessions, filter])

  if (filtered.length === 0) {
    return (
      <div className="px-3 py-8 text-center text-xs text-zinc-600">
        {filter ? "No matching sessions" : "No sessions found"}
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-0.5 px-2 pb-3">
        {filtered.map((s) => {
          const row = (
            <button
              key={s.fileName}
              onClick={() => onSelectSession(s)}
              className={cn(
                "group w-full flex flex-col gap-1 rounded-lg px-2.5 text-left transition-all hover:bg-zinc-900 border border-transparent hover:border-zinc-800 border-l-2 border-l-transparent",
                isMobile ? "py-3.5" : "py-2.5"
              )}
            >
              {/* Top row: slug or session id + model */}
              <div className="flex items-center gap-2">
                {s.lastModified &&
                Date.now() - new Date(s.lastModified).getTime() < 120000 ? (
                  <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    <span className="absolute inline-flex h-2.5 w-2.5 animate-ping rounded-full bg-green-400 opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
                  </span>
                ) : (
                  <FileText className="size-3.5 shrink-0 text-zinc-600 group-hover:text-blue-400" />
                )}
                <span className="text-xs font-medium text-zinc-300 truncate flex-1">
                  {s.slug || truncate(s.sessionId, 16)}
                </span>
                {s.branchedFrom && <Copy className="size-2.5 text-purple-400 shrink-0" title="Duplicated session" />}
                {s.model && (
                  <Badge
                    variant="outline"
                    className="h-4 px-1 text-[9px] font-normal border-zinc-700 text-zinc-500 shrink-0"
                  >
                    {shortenModel(s.model)}
                  </Badge>
                )}
              </div>

              {/* Preview message */}
              {s.firstUserMessage && (
                <p className="ml-5.5 text-[11px] text-zinc-500 line-clamp-2 leading-snug">
                  {s.firstUserMessage}
                </p>
              )}

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
                {s.lastModified && (
                  <span>{formatRelativeTime(s.lastModified)}</span>
                )}
              </div>
            </button>
          )

          if (onDuplicateSession || onDeleteSession) {
            return (
              <SessionContextMenu
                key={s.fileName}
                sessionLabel={s.slug || s.sessionId.slice(0, 12)}
                onDuplicate={onDuplicateSession ? () => onDuplicateSession(s) : undefined}
                onDelete={onDeleteSession ? () => onDeleteSession(s) : undefined}
              >
                {row}
              </SessionContextMenu>
            )
          }

          return row
        })}
        {hasMore && !filter && (
          <button
            onClick={onLoadMore}
            disabled={isLoading}
            className="mx-2 mt-1 mb-1 rounded-md border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-xs text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-300 transition-colors disabled:opacity-50"
          >
            {isLoading ? "Loading..." : "Load more sessions"}
          </button>
        )}
      </div>
    </ScrollArea>
  )
})

// ── Session Detail (info + stats, no tool calls) ──────────────────────────

function SessionDetail({ session }: { session: ParsedSession }) {
  const totalToolCalls = Object.values(session.stats.toolCallCounts).reduce(
    (a, b) => a + b,
    0
  )
  const totalThinkingBlocks = session.turns.reduce(
    (sum, t) => sum + t.thinking.length,
    0
  )

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-0 px-3 pb-3">
        {/* Session Info */}
        <div className="flex flex-col gap-1.5 py-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 border-l-2 border-blue-500/30 pl-2">
            Session
          </h3>

          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1.5 text-xs text-zinc-400">
                <Hash className="size-3 shrink-0 text-zinc-600" />
                <span className="truncate font-mono">
                  {truncate(session.sessionId, 20)}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="right">{session.sessionId}</TooltipContent>
          </Tooltip>

          {session.slug && (
            <div className="flex items-center gap-1.5 text-xs text-zinc-400">
              <FileText className="size-3 shrink-0 text-zinc-600" />
              <span className="truncate">{session.slug}</span>
            </div>
          )}

          <div className="flex items-center gap-1.5 text-xs text-zinc-400">
            <Cpu className="size-3 shrink-0 text-zinc-600" />
            <Badge
              variant="secondary"
              className="h-4 px-1.5 text-[10px] font-normal"
            >
              {session.model || "unknown"}
            </Badge>
          </div>

          {session.version && (
            <div className="flex items-center gap-1.5 text-xs text-zinc-400">
              <Zap className="size-3 shrink-0 text-zinc-600" />
              <Badge
                variant="outline"
                className="h-4 px-1.5 text-[10px] font-normal"
              >
                v{session.version}
              </Badge>
            </div>
          )}

          {session.gitBranch && (
            <div className="flex items-center gap-1.5 text-xs text-zinc-400">
              <GitBranch className="size-3 shrink-0 text-zinc-600" />
              <Badge
                variant="outline"
                className="h-4 px-1.5 text-[10px] font-normal"
              >
                {session.gitBranch}
              </Badge>
            </div>
          )}

          {session.cwd && (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-center gap-1.5 text-xs text-zinc-400">
                  <FolderOpen className="size-3 shrink-0 text-zinc-600" />
                  <span className="truncate font-mono text-[10px]">
                    {truncate(session.cwd, 28)}
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent side="right">{session.cwd}</TooltipContent>
            </Tooltip>
          )}
        </div>

        <Separator className="bg-zinc-800" />

        {/* Quick Stats */}
        <div className="flex flex-col gap-1.5 py-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 border-l-2 border-blue-500/30 pl-2">
            Stats
          </h3>
          <div className="grid grid-cols-2 gap-1.5">
            <SidebarStatCard
              icon={<MessageSquare className="size-3" />}
              label="Turns"
              value={String(session.stats.turnCount)}
            />
            <SidebarStatCard
              icon={<Wrench className="size-3" />}
              label="Tool Calls"
              value={String(totalToolCalls)}
            />
            <SidebarStatCard
              icon={<Brain className="size-3" />}
              label="Thinking"
              value={String(totalThinkingBlocks)}
            />
            <SidebarStatCard
              icon={<AlertTriangle className="size-3" />}
              label="Errors"
              value={String(session.stats.errorCount)}
              variant={session.stats.errorCount > 0 ? "error" : "default"}
            />
            <SidebarStatCard
              icon={<Clock className="size-3" />}
              label="Duration"
              value={formatDuration(session.stats.totalDurationMs)}
            />
            <SidebarStatCard
              icon={<ArrowDownLeft className="size-3" />}
              label="New+Write"
              value={formatTokenCount(
                session.stats.totalInputTokens
                + session.stats.totalCacheCreationTokens
              )}
              tooltip={`New: ${formatTokenCount(session.stats.totalInputTokens)} · Cache write: ${formatTokenCount(session.stats.totalCacheCreationTokens)}`}
            />
            <SidebarStatCard
              icon={<Brain className="size-3" />}
              label="Read"
              value={formatTokenCount(session.stats.totalCacheReadTokens)}
              tooltip="Cache read tokens (served from prompt cache)"
            />
            <SidebarStatCard
              icon={<ArrowUpRight className="size-3" />}
              label="Output"
              value={formatTokenCount(session.stats.totalOutputTokens)}
            />
            <SidebarStatCard
              icon={<DollarSign className="size-3" />}
              label="API Cost"
              value={formatCost(session.stats.totalCostUSD)}
              tooltip="Estimated cost based on Anthropic API pricing"
            />
          </div>
        </div>
      </div>
    </ScrollArea>
  )
}

function SidebarStatCard({
  icon,
  label,
  value,
  variant = "default",
  tooltip,
}: {
  icon: React.ReactNode
  label: string
  value: string
  variant?: "default" | "error"
  tooltip?: string
}) {
  const card = (
    <div
      className={cn(
        "flex flex-col gap-0.5 rounded-md border px-2 py-1.5",
        variant === "error" && Number(value) > 0
          ? "border-red-900/50 bg-red-950/30"
          : "border-zinc-800 bg-zinc-900/50"
      )}
    >
      <div className="flex items-center gap-1 text-zinc-500">
        {icon}
        <span className="text-[10px]">{label}</span>
      </div>
      <span
        className={cn(
          "text-sm font-semibold",
          variant === "error" && Number(value) > 0
            ? "text-red-400"
            : "text-zinc-200"
        )}
      >
        {value}
      </span>
    </div>
  )

  if (tooltip) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{card}</TooltipTrigger>
        <TooltipContent side="right">{tooltip}</TooltipContent>
      </Tooltip>
    )
  }

  return card
}
