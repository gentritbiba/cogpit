import { MessageSquare, GitBranch, Clock, FolderOpen, Plus, Loader2, FileText, ChevronLeft } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { SessionContextMenu } from "@/components/SessionContextMenu"
import { cn } from "@/lib/utils"
import { shortenModel, formatRelativeTime, formatFileSize, truncate, shortPath, projectName } from "@/lib/format"
import { SearchInput, ErrorBanner, SkeletonCards, LiveDot } from "./DashboardWidgets"

const LIVE_THRESHOLD_MS = 2 * 60 * 1000

function isLive(lastModified: string | null): boolean {
  if (!lastModified) return false
  return Date.now() - new Date(lastModified).getTime() < LIVE_THRESHOLD_MS
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

export interface SessionsViewProps {
  selectedProject: ProjectInfo
  sessions: SessionInfo[]
  sessionsTotal: number
  sessionsLoading: boolean
  searchFilter: string
  setSearchFilter: (v: string) => void
  filteredSessions: SessionInfo[]
  fetchError: string | null
  onSelectSession: (dirName: string, fileName: string) => void
  onNewSession?: (dirName: string, cwd?: string) => void
  creatingSession?: boolean
  onDuplicateSession?: (dirName: string, fileName: string) => void
  onDeleteSession?: (dirName: string, fileName: string) => void
  onBack: () => void
  onRetryFetch: () => void
  loadMoreSessions: () => void
}

export function SessionsView({
  selectedProject,
  sessions,
  sessionsTotal,
  sessionsLoading,
  searchFilter,
  setSearchFilter,
  filteredSessions,
  fetchError,
  onSelectSession,
  onNewSession,
  creatingSession,
  onDuplicateSession,
  onDeleteSession,
  onBack,
  onRetryFetch,
  loadMoreSessions,
}: SessionsViewProps) {
  function handleDeleteSession(dirName: string, fileName: string) {
    onDeleteSession?.(dirName, fileName)
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

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-5xl px-6 py-8 fade-in">
        {/* Header with back button */}
        <div className="mb-6">
          <button
            onClick={onBack}
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
            onRetry={onRetryFetch}
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
