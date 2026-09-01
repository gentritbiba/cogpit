import { Activity, AlertTriangle, LoaderCircle, RefreshCw, Search, X } from "lucide-react"

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
import { cn } from "@/lib/utils"

interface LiveSessionsToolbarProps {
  loading: boolean
  isMobile: boolean
  searchQuery: string
  searchLoading: boolean
  onSearchQueryChange: (query: string) => void
  onRefresh: () => void
}

export function LiveSessionsToolbar({
  loading,
  isMobile,
  searchQuery,
  searchLoading,
  onSearchQueryChange,
  onRefresh,
}: LiveSessionsToolbarProps) {
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
  onRetry: () => void
}

const SKELETON_ROWS = ["first", "second", "third", "fourth", "fifth"]

export function LiveSessionsFeedback({
  fetchError,
  showEmpty,
  searching,
  loading,
  sessionCount,
  onRetry,
}: LiveSessionsFeedbackProps) {
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

      {showEmpty && (
        <Empty className="min-h-56 px-4 py-8">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              {searching ? <Search /> : <Activity />}
            </EmptyMedia>
            <EmptyTitle>{searching ? "No matching sessions" : "No sessions yet"}</EmptyTitle>
            <EmptyDescription>
              {searching
                ? "Try #157, honest-cms #157, or paste a PR URL."
                : "Start Claude Code or Codex to see recent work here."}
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
