import { Fragment } from "react"
import { ChevronRight, FolderOpen, GitBranch, MessageSquare, Plus } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/Spinner"
import { SessionContextMenu } from "@/components/SessionContextMenu"
import {
  formatFileSize,
  formatRelativeTime,
  projectName,
  shortenModel,
  shortPath,
  truncate,
} from "@/lib/format"
import { ErrorBanner, SearchInput, SkeletonRows } from "./DashboardWidgets"

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

interface SessionsViewProps {
  selectedProject: ProjectInfo
  sessions: SessionInfo[]
  sessionsTotal: number
  sessionsLoading: boolean
  searchFilter: string
  setSearchFilter: (value: string) => void
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
  function withContextMenu(session: SessionInfo, content: React.ReactNode): React.ReactNode {
    if (!onDuplicateSession && !onDeleteSession) return content

    return (
      <SessionContextMenu
        sessionLabel={session.slug || session.sessionId.slice(0, 12)}
        onDuplicate={onDuplicateSession
          ? () => onDuplicateSession(selectedProject.dirName, session.fileName)
          : undefined}
        onDelete={onDeleteSession
          ? () => onDeleteSession(selectedProject.dirName, session.fileName)
          : undefined}
      >
        {content}
      </SessionContextMenu>
    )
  }

  const selectedProjectName = projectName(selectedProject.path)

  return (
    <ScrollArea className="h-full">
      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink render={<button type="button" onClick={onBack} />}>
                Projects
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem className="min-w-0">
              <BreadcrumbPage className="truncate">{selectedProjectName}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>

        <header className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-2xl font-semibold tracking-tight">
              {selectedProjectName}
            </h1>
            <Badge variant="secondary">{sessionsTotal}</Badge>
          </div>
          <p className="truncate text-sm text-muted-foreground">
            {shortPath(selectedProject.path)}
          </p>
        </header>

        <section className="flex flex-col gap-4" aria-label="Sessions">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <SearchInput
              value={searchFilter}
              onChange={setSearchFilter}
              placeholder="Filter sessions..."
            />
            {onNewSession && (
              <Button
                size="sm"
                disabled={creatingSession}
                onClick={() => onNewSession(selectedProject.dirName, selectedProject.path)}
              >
                {creatingSession ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <Plus data-icon="inline-start" />
                )}
                New Session
              </Button>
            )}
          </div>

          {fetchError && <ErrorBanner message={fetchError} onRetry={onRetryFetch} />}

          {sessionsLoading && sessions.length === 0 ? (
            <SkeletonRows includeMessagePlaceholder />
          ) : filteredSessions.length === 0 ? (
            <Empty className="min-h-72 border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <MessageSquare />
                </EmptyMedia>
                <EmptyTitle>
                  {searchFilter ? "No sessions match your search" : "No sessions yet"}
                </EmptyTitle>
                <EmptyDescription>
                  {searchFilter
                    ? "Try a session title, model, or ID."
                    : "Start a session in this project and it will appear here."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <>
              <div className="overflow-hidden rounded-lg border bg-card">
                {filteredSessions.map((session, index) => {
                  const live = isLive(session.lastModified)
                  const title = session.slug || truncate(session.sessionId, 16)

                  const row = (
                    <button
                      type="button"
                      onClick={() => onSelectSession(selectedProject.dirName, session.fileName)}
                      className="group flex w-full flex-col gap-3 px-4 py-3.5 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:flex-row sm:items-center"
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-3">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground">
                          <FolderOpen className="size-4" />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">{title}</span>
                          <span className="block truncate text-sm text-muted-foreground">
                            {session.firstUserMessage
                              ? truncate(session.firstUserMessage, 100)
                              : "No opening message"}
                          </span>
                        </span>
                      </span>

                      <span className="flex flex-wrap items-center gap-x-4 gap-y-2 pl-11 text-xs text-muted-foreground sm:justify-end sm:pl-0">
                        {live && (
                          <Badge variant="secondary">
                            <span
                              aria-hidden="true"
                              data-icon="inline-start"
                              className="size-1.5 rounded-full bg-success"
                            />
                            Active
                          </Badge>
                        )}
                        {session.model && (
                          <Badge variant="outline">{shortenModel(session.model)}</Badge>
                        )}
                        {(session.turnCount ?? 0) > 0 && (
                          <span>{session.turnCount} turns</span>
                        )}
                        {session.gitBranch && (
                          <span className="flex max-w-36 items-center gap-1 truncate">
                            <GitBranch className="size-3 shrink-0" />
                            {truncate(session.gitBranch, 20)}
                          </span>
                        )}
                        <span>{formatFileSize(session.size)}</span>
                        {session.lastModified && (
                          <span className="hidden whitespace-nowrap md:inline">
                            {formatRelativeTime(session.lastModified)}
                          </span>
                        )}
                        <ChevronRight className="size-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
                      </span>
                    </button>
                  )

                  return (
                    <Fragment key={session.fileName}>
                      {index > 0 && <Separator />}
                      {withContextMenu(session, row)}
                    </Fragment>
                  )
                })}
              </div>

              {sessions.length < sessionsTotal && !searchFilter && (
                <div className="flex justify-center">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={sessionsLoading}
                    onClick={loadMoreSessions}
                  >
                    {sessionsLoading && <Spinner data-icon="inline-start" />}
                    {sessionsLoading ? "Loading..." : "Load more sessions"}
                  </Button>
                </div>
              )}
            </>
          )}
        </section>
      </main>
    </ScrollArea>
  )
}
