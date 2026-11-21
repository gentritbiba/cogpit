import type { ReactNode } from "react"
import { Activity, AlertTriangle, Archive, Check, FolderSearch, Layers, ListFilter, ListTree, LoaderCircle, Plus, RefreshCw, Search, X } from "lucide-react"

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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

interface SessionSearchFieldProps {
  searchQuery: string
  searchLoading: boolean
  onSearchQueryChange: (query: string) => void
  /** Clears the query and puts the field away: Escape, or its close button. */
  onClose: () => void
  /** Focus left the field with nothing typed, so it can go away quietly. */
  onDismiss: () => void
}

/** The list's filter, shown only while the user is searching. */
export function SessionSearchField({
  searchQuery,
  searchLoading,
  onSearchQueryChange,
  onClose,
  onDismiss,
}: SessionSearchFieldProps) {
  return (
    <div
      className="shrink-0 px-2 pb-2"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget) && !searchQuery.trim()) onDismiss()
      }}
    >
      <InputGroup>
        <InputGroupInput
          type="search"
          autoFocus
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape") onClose() }}
          placeholder="Search sessions or PRs"
          aria-label="Search sessions by project, branch, title, prompt, PR number, or PR URL"
          aria-busy={searchLoading}
        />
        <InputGroupAddon align="inline-start">
          {searchLoading ? <LoaderCircle className="animate-spin" /> : <Search />}
        </InputGroupAddon>
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-xs"
            onClick={onClose}
            aria-label="Close session search"
          >
            <X data-icon="inline-start" />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  )
}

interface SessionListOptionsProps {
  loading: boolean
  showArchived: boolean
  archivedCount: number
  /** Whether sessions another session started are listed under it. */
  groupCrews: boolean
  onToggleGroupCrews: () => void
  onToggleShowArchived: () => void
  onRefresh: () => void
  /** Starts a session in a folder the list does not show; absent where sessions cannot be started. */
  onNewInFolder?: () => void
}

/** How the list is arranged, and the rarer ways to act on it, behind one button. */
export function SessionListOptions({
  loading,
  showArchived,
  archivedCount,
  groupCrews,
  onToggleGroupCrews,
  onToggleShowArchived,
  onRefresh,
  onNewInFolder,
}: SessionListOptionsProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={(
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Session list options"
            title="Session list options"
            className="shrink-0 text-muted-foreground hover:text-foreground data-popup-open:bg-accent"
          />
        )}
      >
        {loading ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <ListFilter data-icon="inline-start" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuItem
            role="menuitemcheckbox"
            aria-checked={groupCrews}
            closeOnClick={false}
            onClick={onToggleGroupCrews}
          >
            <ListTree />
            Group spawned sessions
            {groupCrews && <Check className="ml-auto" />}
          </DropdownMenuItem>
          <DropdownMenuItem
            role="menuitemcheckbox"
            aria-checked={showArchived}
            closeOnClick={false}
            onClick={onToggleShowArchived}
          >
            <Archive />
            Show archived
            <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
              {archivedCount > 0 && archivedCount}
              {showArchived && <Check className="text-foreground" />}
            </span>
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          {onNewInFolder && (
            <DropdownMenuItem onClick={onNewInFolder}>
              <FolderSearch />
              New session in another folder…
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={onRefresh}>
            <RefreshCw />
            Refresh sessions
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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
  /** Stands for a list the edition's session filter left empty; null while the list is unfiltered. */
  filterEmpty?: ReactNode
  onShowArchived: () => void
  /** Opens the new-session picker; without it the empty list offers no way to start one. */
  onNewSession?: () => void
  /** Starts a session in the focused project, which its empty state offers first. */
  onNewSessionHere?: () => void
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
  filterEmpty = null,
  onShowArchived,
  onNewSession,
  onNewSessionHere,
  onRetry,
}: LiveSessionsFeedbackProps) {
  const empty = emptyVariant({ showEmpty, searching, focusedProject, hiddenArchivedCount, filtered: Boolean(filterEmpty) })
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
            {!searching && onNewSessionHere && (
              <Button size="sm" onClick={onNewSessionHere}>
                <Plus data-icon="inline-start" />
                New session
              </Button>
            )}
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

      {empty === "filtered" && filterEmpty}

      {empty === "plain" && (
        <Empty className="min-h-56 px-4 py-8">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              {searching ? <Search /> : <Activity />}
            </EmptyMedia>
            <EmptyTitle>{searching ? "No matching sessions" : "No sessions yet"}</EmptyTitle>
            <EmptyDescription>
              {plainEmptyDescription(searching, Boolean(onNewSession))}
            </EmptyDescription>
          </EmptyHeader>
          {!searching && onNewSession && (
            <Button size="sm" onClick={onNewSession}>
              <Plus data-icon="inline-start" />
              New session
            </Button>
          )}
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
 * first, then a list emptied only by the archive filter, then one the
 * edition's session filter emptied, then the plain case.
 */
function emptyVariant({
  showEmpty,
  searching,
  focusedProject,
  hiddenArchivedCount,
  filtered,
}: {
  showEmpty: boolean
  searching: boolean
  focusedProject: string | null
  hiddenArchivedCount: number
  filtered: boolean
}): "archived" | "focused" | "filtered" | "plain" | null {
  if (!showEmpty) return null
  if (focusedProject !== null) return "focused"
  if (!searching && hiddenArchivedCount > 0) return "archived"
  if (!searching && filtered) return "filtered"
  return "plain"
}

function plainEmptyDescription(searching: boolean, canStart: boolean): string {
  if (searching) return "Try #157, honest-cms #157, or paste a PR URL."
  if (canStart) return "Pick a project or folder to start your first session."
  return "Start Claude Code, Codex, or Copilot to see recent work here."
}

function focusedEmptyDescription(searching: boolean, hiddenArchivedCount: number): string {
  if (searching) return "Try another search, or look across every project."
  if (hiddenArchivedCount > 0) return "Its sessions may be archived. Start a new one, or look across every project."
  return "Start a new session here, or look across every project."
}
