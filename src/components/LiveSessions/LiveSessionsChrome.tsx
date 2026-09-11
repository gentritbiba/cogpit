import { Activity, AlertTriangle, Archive, Layers, LoaderCircle, RefreshCw, Search, X } from "lucide-react"

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

interface LiveSessionsToolbarProps {
  loading: boolean
  isMobile: boolean
  searchQuery: string
  searchLoading: boolean
  showArchived: boolean
  archivedCount: number
  onSearchQueryChange: (query: string) => void
  onToggleShowArchived: () => void
  onRefresh: () => void
}

export function LiveSessionsToolbar({
  loading,
  isMobile,
  searchQuery,
  searchLoading,
  showArchived,
  archivedCount,
  onSearchQueryChange,
  onToggleShowArchived,
  onRefresh,
}: LiveSessionsToolbarProps) {
  const archivedSummary = archivedCount === 0
    ? "No archived sessions"
    : `${archivedCount} archived ${archivedCount === 1 ? "session" : "sessions"}`
  return (
    <div className="flex shrink-0 items-center gap-2 border-b px-2.5 py-2">
      <InputGroup>
        <InputGroupInput
          type="search"
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.target.value)}
          placeholder="Search sessions or PRs"
          aria-label="Search sessions by project, branch, title, prompt, PR number, or PR URL"
          aria-busy={searchLoading}
        />
        <InputGroupAddon align="inline-start">
          {searchLoading ? <LoaderCircle className="animate-spin" /> : <Search />}
        </InputGroupAddon>
        {searchQuery && (
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              size="icon-xs"
              onClick={() => onSearchQueryChange("")}
              aria-label="Clear session search"
            >
              <X data-icon="inline-start" />
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size={isMobile ? "icon-sm" : "icon-xs"}
              onClick={onToggleShowArchived}
              aria-pressed={showArchived}
              aria-label={showArchived ? "Hide archived sessions" : "Show archived sessions"}
              className={cn(showArchived && "bg-accent text-accent-foreground")}
            />
          }
        >
          <Archive data-icon="inline-start" />
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {showArchived ? "Hide archived" : "Show archived"} · {archivedSummary}
        </TooltipContent>
      </Tooltip>
      <Button
        variant="ghost"
        size={isMobile ? "icon-sm" : "icon-xs"}
        onClick={onRefresh}
        aria-label="Refresh sessions"
      >
        <RefreshCw data-icon="inline-start" className={cn(loading && "animate-spin")} />
      </Button>
    </div>
  )
}

interface LiveSessionsFeedbackProps {
  fetchError: string | null
  showEmpty: boolean
  searching: boolean
  loading: boolean
  sessionCount: number
  /** Archived sessions the current view keeps out of the list. */
  hiddenArchivedCount: number
  /** The project the sidebar is focused on, when it is not showing every project. */
  focusedProject?: string | null
  onShowAllProjects?: () => void
  onShowArchived: () => void
  onRetry: () => void
}

const SKELETON_ROWS = ["first", "second", "third", "fourth", "fifth"]

export function LiveSessionsFeedback({
  fetchError,
  showEmpty,
  searching,
  loading,
  sessionCount,
  hiddenArchivedCount,
  focusedProject = null,
  onShowAllProjects,
  onShowArchived,
  onRetry,
}: LiveSessionsFeedbackProps) {
  const empty = emptyVariant({ showEmpty, searching, focusedProject, hiddenArchivedCount })
  return (
    <>
      {fetchError && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Could not load sessions</AlertTitle>
          <AlertDescription className="truncate">{fetchError}</AlertDescription>
          <AlertAction>
            <Button variant="outline" size="xs" onClick={onRetry}>Retry</Button>
          </AlertAction>
        </Alert>
      )}

      {empty === "archived" && (
        <Empty className="min-h-56 px-4 py-8">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Archive />
            </EmptyMedia>
            <EmptyTitle>Everything is archived</EmptyTitle>
            <EmptyDescription>
              {hiddenArchivedCount === 1
                ? "1 archived session is hidden."
                : `${hiddenArchivedCount} archived sessions are hidden.`}
            </EmptyDescription>
          </EmptyHeader>
          <Button variant="outline" size="sm" onClick={onShowArchived}>
            <Archive data-icon="inline-start" />
            Show archived
          </Button>
        </Empty>
      )}

      {empty === "focused" && (
        <Empty className="min-h-56 px-4 py-8">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              {searching ? <Search /> : <Activity />}
            </EmptyMedia>
            <EmptyTitle>
              {searching ? `No matching sessions in ${focusedProject}` : `No sessions in ${focusedProject}`}
            </EmptyTitle>
            <EmptyDescription>
              {focusedEmptyDescription(searching, hiddenArchivedCount)}
            </EmptyDescription>
          </EmptyHeader>
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="outline" size="sm" onClick={onShowAllProjects}>
              <Layers data-icon="inline-start" />
              All projects
            </Button>
            {!searching && hiddenArchivedCount > 0 && (
              <Button variant="ghost" size="sm" onClick={onShowArchived}>
                <Archive data-icon="inline-start" />
                Show archived
              </Button>
            )}
          </div>
        </Empty>
      )}

      {empty === "plain" && (
        <Empty className="min-h-56 px-4 py-8">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              {searching ? <Search /> : <Activity />}
            </EmptyMedia>
            <EmptyTitle>{searching ? "No matching sessions" : "No sessions yet"}</EmptyTitle>
            <EmptyDescription>
              {searching
                ? "Try #157, honest-cms #157, or paste a PR URL."
                : "Start Claude Code, Codex, or Copilot to see recent work here."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {loading && sessionCount === 0 && (
        <div className="flex flex-col gap-2 px-2 py-4" aria-label="Loading sessions">
          {SKELETON_ROWS.map((row) => (
            <div key={row} className="flex items-center gap-2 py-1">
              <Skeleton className="size-2 shrink-0 rounded-full" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-10" />
            </div>
          ))}
        </div>
      )}
    </>
  )
}

/**
 * Which empty state the list shows, if any. A focused project explains itself
 * first, then a list emptied only by the archive filter, then the plain case.
 */
function emptyVariant({
  showEmpty,
  searching,
  focusedProject,
  hiddenArchivedCount,
}: {
  showEmpty: boolean
  searching: boolean
  focusedProject: string | null
  hiddenArchivedCount: number
}): "archived" | "focused" | "plain" | null {
  if (!showEmpty) return null
  if (focusedProject !== null) return "focused"
  if (!searching && hiddenArchivedCount > 0) return "archived"
  return "plain"
}

function focusedEmptyDescription(searching: boolean, hiddenArchivedCount: number): string {
  if (searching) return "Try another search, or look across every project."
  if (hiddenArchivedCount > 0) return "Its sessions may be archived. Start a new one, or look across every project."
  return "Start a new session here, or look across every project."
}
