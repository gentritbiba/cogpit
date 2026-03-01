import { useCallback } from "react"
import {
  ChevronLeft,
  Search,
  RefreshCw,
  Plus,
  Loader2,
  AlertTriangle,
  MessageSquare,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { projectName } from "@/lib/format"
import type { ParsedSession } from "@/lib/types"
import { useSessionContext } from "@/contexts/SessionContext"
import type { View, ProjectInfo, SessionInfo } from "./types"
import { ProjectsList } from "./ProjectsList"
import { SessionsList } from "./SessionsList"
import { SessionDetail } from "./SessionDetail"

// ── Props ──────────────────────────────────────────────────────────────────

interface BrowseTabProps {
  view: View
  selectedProject: ProjectInfo | null
  projects: ProjectInfo[]
  sessions: SessionInfo[]
  sessionsTotal: number
  isLoading: boolean
  fetchError: string | null
  searchFilter: string
  isMobile?: boolean
  creatingSession?: boolean
  onSearchFilterChange: (value: string) => void
  onBack: () => void
  onRefreshProjects: () => void
  onSelectProject: (p: ProjectInfo) => void
  onSelectSession: (s: SessionInfo) => void
  onDuplicateSession?: (s: SessionInfo) => void
  onDeleteSession?: (s: SessionInfo) => void
  onNewSession?: (dirName: string, cwd?: string) => void
  onLoadMoreSessions: () => void
  onRetry: () => void
  onClearError: () => void
}

// ── Header ─────────────────────────────────────────────────────────────────

function BrowseHeader({
  view,
  selectedProject,
  isLoading,
  isMobile,
  creatingSession,
  onBack,
  onRefreshProjects,
  onNewSession,
}: {
  view: View
  selectedProject: ProjectInfo | null
  isLoading: boolean
  isMobile?: boolean
  creatingSession?: boolean
  onBack: () => void
  onRefreshProjects: () => void
  onNewSession?: (dirName: string, cwd?: string) => void
}): React.ReactElement {
  const sizeClass = isMobile ? "h-8 w-8 p-0" : "h-6 w-6 p-0"
  const iconSize = isMobile ? "size-5" : "size-4"

  function getTitle(): string {
    if (view === "sessions" && selectedProject) {
      return projectName(selectedProject.path)
    }
    if (view === "detail") return "Session"
    return "Projects"
  }

  return (
    <div className={cn(
      "flex shrink-0 items-center gap-2 border-b border-border/50 px-3",
      isMobile ? "py-2.5" : "py-2"
    )}>
      {view !== "projects" && (
        <Button
          variant="ghost"
          size="sm"
          className={sizeClass}
          onClick={onBack}
          aria-label="Go back"
        >
          <ChevronLeft className={iconSize} />
        </Button>
      )}
      <span className={cn(
        "font-medium text-muted-foreground truncate flex-1",
        isMobile ? "text-sm" : "text-xs"
      )}>
        {getTitle()}
      </span>
      {view === "projects" && (
        <Button
          variant="ghost"
          size="sm"
          className={sizeClass}
          onClick={onRefreshProjects}
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
              className={sizeClass}
              disabled={creatingSession}
              onClick={() => onNewSession(selectedProject.dirName, selectedProject.path)}
            >
              {creatingSession
                ? <Loader2 className={cn(isMobile ? "size-4" : "size-3.5", "animate-spin")} />
                : <Plus className={cn(isMobile ? "size-4" : "size-3.5")} />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {creatingSession ? "Creating session..." : `New session in ${projectName(selectedProject.path)}`}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

// ── Search Bar ─────────────────────────────────────────────────────────────

function SearchBar({
  value,
  placeholder,
  isMobile,
  onChange,
}: {
  value: string
  placeholder: string
  isMobile?: boolean
  onChange: (value: string) => void
}): React.ReactElement {
  return (
    <div className="shrink-0 px-2 pb-2 pt-1">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={cn(
            "w-full rounded-lg border border-border/60 elevation-2 depth-low pl-8 text-foreground placeholder:text-muted-foreground focus:border-blue-500/40 focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-colors",
            isMobile ? "py-2.5 text-sm" : "py-2 text-xs",
            value && "pr-8"
          )}
        />
        {value && (
          <button
            onClick={() => onChange("")}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            aria-label="Clear search"
          >
            <X className="size-3" />
          </button>
        )}
      </div>
    </div>
  )
}

// ── Error Banner ───────────────────────────────────────────────────────────

function ErrorBanner({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}): React.ReactElement {
  return (
    <div className="shrink-0 mx-3 mb-1 flex items-center gap-2 rounded-md border border-red-900/50 bg-red-950/30 px-2.5 py-1.5">
      <AlertTriangle className="size-3 text-red-400 shrink-0" />
      <span className="text-[11px] text-red-400 flex-1 truncate">{message}</span>
      <Button
        variant="ghost"
        size="sm"
        className="h-5 px-1.5 text-[10px] text-red-400 hover:text-red-300 hover:bg-red-500/10"
        onClick={onRetry}
      >
        <RefreshCw className="size-2.5 mr-1" />
        Retry
      </Button>
    </div>
  )
}

// ── Mobile Detail Placeholder ──────────────────────────────────────────────

function MobileDetailPlaceholder({ session }: { session: ParsedSession }): React.ReactElement {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 px-6 text-center">
      <MessageSquare className="size-8 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">
        Session loaded: <span className="font-medium text-foreground">{session.slug || session.sessionId.slice(0, 12)}</span>
      </p>
      <p className="text-xs text-muted-foreground">
        Tap the Chat tab below to view the conversation
      </p>
    </div>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────

export function BrowseTab({
  view,
  selectedProject,
  projects,
  sessions,
  sessionsTotal,
  isLoading,
  fetchError,
  searchFilter,
  isMobile,
  creatingSession,
  onSearchFilterChange,
  onBack,
  onRefreshProjects,
  onSelectProject,
  onSelectSession,
  onDuplicateSession,
  onDeleteSession,
  onNewSession,
  onLoadMoreSessions,
  onRetry,
  onClearError,
}: BrowseTabProps): React.ReactElement {
  const { session } = useSessionContext()
  const searchPlaceholder = view === "projects" ? "Filter projects..." : "Filter sessions..."

  const handleRetry = useCallback(() => {
    onClearError()
    onRetry()
  }, [onClearError, onRetry])

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <BrowseHeader
        view={view}
        selectedProject={selectedProject}
        isLoading={isLoading}
        isMobile={isMobile}
        creatingSession={creatingSession}
        onBack={onBack}
        onRefreshProjects={onRefreshProjects}
        onNewSession={onNewSession}
      />

      {view !== "detail" && (
        <SearchBar
          value={searchFilter}
          placeholder={searchPlaceholder}
          isMobile={isMobile}
          onChange={onSearchFilterChange}
        />
      )}

      {fetchError && (
        <ErrorBanner message={fetchError} onRetry={handleRetry} />
      )}

      <div className="flex-1 min-h-0">
        {view === "projects" && (
          <ProjectsList
            projects={projects}
            filter={searchFilter}
            onSelectProject={onSelectProject}
            isMobile={isMobile}
          />
        )}
        {view === "sessions" && selectedProject && (
          <SessionsList
            sessions={sessions}
            filter={searchFilter}
            onSelectSession={onSelectSession}
            onDuplicateSession={onDuplicateSession}
            onDeleteSession={onDeleteSession}
            isMobile={isMobile}
            hasMore={sessions.length < sessionsTotal}
            isLoading={isLoading}
            onLoadMore={onLoadMoreSessions}
          />
        )}
        {view === "detail" && session && !isMobile && (
          <SessionDetail session={session} />
        )}
        {view === "detail" && session && isMobile && (
          <MobileDetailPlaceholder session={session} />
        )}
      </div>
    </div>
  )
}
