import { Fragment } from "react"
import { MessageSquare, Plus } from "lucide-react"
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
import { useSessionNames } from "@/hooks/useSessionNames"
import { projectName, shortPath } from "@/lib/format"
import { ErrorBanner, SearchInput, SkeletonRows } from "./DashboardWidgets"
import { SessionListRow } from "./SessionListRow"
import { sessionRowTitle } from "./sessionPresentation"
import type { ProjectInfo, SessionInfo } from "./types"

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
  const { names: sessionNames, rename: renameSession } = useSessionNames()
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
                    ? "Try a session title, prompt, model, or branch."
                    : "Start a session in this project and it will appear here."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <>
              <div className="overflow-hidden rounded-lg border bg-card">
                {filteredSessions.map((session, index) => (
                  <Fragment key={session.fileName}>
                    {index > 0 && <Separator />}
                    <SessionContextMenu
                      sessionLabel={sessionRowTitle(session)}
                      customName={sessionNames[session.sessionId]}
                      onRename={(name) => renameSession(session.sessionId, name)}
                      onDuplicate={onDuplicateSession
                        ? () => onDuplicateSession(selectedProject.dirName, session.fileName)
                        : undefined}
                      onDelete={onDeleteSession
                        ? () => onDeleteSession(selectedProject.dirName, session.fileName)
                        : undefined}
                    >
                      <SessionListRow
                        session={session}
                        customName={sessionNames[session.sessionId]}
                        onSelect={() => onSelectSession(selectedProject.dirName, session.fileName)}
                      />
                    </SessionContextMenu>
                  </Fragment>
                ))}
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
