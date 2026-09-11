import { useState } from "react"
import {
  Archive,
  ArchiveRestore,
  Bot,
  ChevronRight,
  GitBranch,
  MessageSquare,
  Play,
  Users,
  X,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { PullRequestChips } from "@/components/PullRequestChips"
import { SessionContextMenu } from "@/components/SessionContextMenu"
import { cn } from "@/lib/utils"
import { formatRelativeTime } from "@/lib/format"
import { resolveTurnCount } from "@/lib/turnCountCache"
import { getStatusColor } from "./sessionStatusPresentation"
import { archivedReasonLabel, sessionHeadline } from "./sessionListView"
import { describeSessionRow } from "./sessionRowState"
import type { SessionRowProps } from "./SessionRow"
import { STATUS_DOT } from "./statusDot"
import { useHoverPrefetch } from "./useHoverPrefetch"

/**
 * A session with room to breathe: the sidebar's row, expanded for the focused
 * project view where one project's sessions are the whole list. Same actions
 * as the row, plus the last prompt and vitals the row keeps in its tooltip.
 */
export function SessionCard({
  session: s,
  isActiveSession,
  proc,
  killingPids,
  isNewlyCompleted,
  customName,
  worktreeName,
  teammateCount,
  teammatesCollapsed,
  onToggleTeammates,
  onSelectSession,
  onKill,
  onDuplicateSession,
  onDeleteSession,
  onArchiveSession,
  onUnarchiveSession,
  onRenameSession,
  onPrefetchSession,
  onResumeSession,
}: SessionRowProps) {
  const {
    isLive,
    isNativeIdle,
    isDeferred,
    isReadOnly,
    isTeammate,
    isArchived,
    statusLabel,
    dotState,
    justFinished,
  } = describeSessionRow(s, proc, isNewlyCompleted)
  const [resuming, setResuming] = useState(false)
  const headline = sessionHeadline(s, customName)
  const lastPrompt = s.lastUserMessage || s.firstUserMessage
  const showPrompt = Boolean(lastPrompt) && lastPrompt !== headline
  const turnCount = resolveTurnCount(s.sessionId, s.turnCount)
  const archivedLabel = archivedReasonLabel(s.archivedReason)
  const archiveAction = isArchived
    ? onUnarchiveSession && { label: "Restore from archive", icon: ArchiveRestore, run: () => onUnarchiveSession(s) }
    : onArchiveSession && !isLive && { label: "Archive session", icon: Archive, run: () => onArchiveSession(s) }
  const canResume = isDeferred && Boolean(onResumeSession) && !isReadOnly
  const hasTeamToggle = Boolean(teammateCount) && Boolean(onToggleTeammates)
  const hasPullRequests = Boolean(s.matchedPullRequestNumber) || Boolean(s.pullRequests?.length)
  const hasFooter = canResume || hasTeamToggle || hasPullRequests

  const { onHoverStart, onHoverEnd } = useHoverPrefetch(
    onPrefetchSession && !isActiveSession
      ? () => onPrefetchSession(s.dirName, s.fileName)
      : undefined,
  )

  const handleResume = () => {
    if (!onResumeSession || resuming) return
    setResuming(true)
    onResumeSession(s.sessionId, s.cwd, s.dirName)
    setTimeout(() => setResuming(false), 3000)
  }

  const card = (
    <div
      data-session-card
      data-archived={isArchived || undefined}
      className={cn(
        "motion-list-item group relative flex flex-col rounded-lg border transition-colors",
        surface(isActiveSession, justFinished),
        isArchived && "opacity-60 hover:opacity-100 focus-within:opacity-100",
      )}
    >
      <button
        type="button"
        data-live-session
        onClick={() => onSelectSession(s.dirName, s.fileName)}
        onMouseEnter={onHoverStart}
        onMouseLeave={onHoverEnd}
        onFocus={onHoverStart}
        onBlur={onHoverEnd}
        aria-current={isActiveSession ? "true" : undefined}
        className={cn(
          "flex w-full flex-col gap-1.5 rounded-lg px-3 pt-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
          hasFooter ? "pb-1.5" : "pb-2.5",
        )}
      >
        <span className="flex items-start gap-2">
          <span className="mt-[7px] flex w-1.5 shrink-0 justify-center" aria-hidden="true">
            {dotState && (
              <span
                data-status-dot={dotState}
                className={cn("size-1.5 rounded-full", STATUS_DOT[dotState])}
              />
            )}
          </span>
          <span className="line-clamp-2 flex-1 text-sm font-medium leading-snug text-foreground">
            {headline}
          </span>
        </span>
        {showPrompt && (
          <span className="line-clamp-2 pl-3.5 text-xs leading-relaxed text-muted-foreground">
            {lastPrompt}
          </span>
        )}
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-3.5 text-[11px] text-muted-foreground">
          {isLive && !isDeferred && statusLabel && (
            <Badge
              variant="secondary"
              data-session-live-state
              className={cn(isNativeIdle ? "text-success" : getStatusColor(s.agentStatus))}
            >
              {statusLabel}
            </Badge>
          )}
          {isDeferred && (
            <Badge variant="outline" className="border-warning/30 bg-warning/10 text-warning">
              deferred
            </Badge>
          )}
          {isTeammate && (
            <Badge variant="outline">
              <Bot data-icon="inline-start" />
              {headline !== s.agentName ? s.agentName : "Agent"}
            </Badge>
          )}
          {worktreeName && (
            <Badge variant="outline">
              <GitBranch data-icon="inline-start" />
              {worktreeName}
            </Badge>
          )}
          {s.gitBranch && !worktreeName && (
            <span className="flex min-w-0 items-center gap-1">
              <GitBranch className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{s.gitBranch}</span>
            </span>
          )}
          {turnCount > 0 && (
            <span className="flex items-center gap-1">
              <MessageSquare className="size-3 shrink-0" aria-hidden="true" />
              {turnCount} {turnCount === 1 ? "turn" : "turns"}
            </span>
          )}
          {isArchived && (
            <span className="flex items-center gap-1">
              <Archive className="size-3 shrink-0" aria-label={archivedLabel} role="img" />
              Archived
            </span>
          )}
          <span className="ml-auto tabular-nums">
            {formatRelativeTime(s.lastActivityAt || s.lastModified)}
          </span>
        </span>
      </button>

      {hasFooter && (
        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2.5 pl-[26px]">
          {s.matchedPullRequestNumber ? (
            <Badge variant="outline" className="px-1">
              Matched #{s.matchedPullRequestNumber}
            </Badge>
          ) : (
            <PullRequestChips pullRequests={s.pullRequests} max={2} compact />
          )}
          {hasTeamToggle && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={onToggleTeammates}
              aria-expanded={!teammatesCollapsed}
              aria-label={teammatesCollapsed ? `Show ${teammateCount} team agents` : `Hide ${teammateCount} team agents`}
            >
              <Users data-icon="inline-start" />
              {teammateCount}
              <ChevronRight
                data-icon="inline-end"
                className={cn("transition-transform duration-150", !teammatesCollapsed && "rotate-90")}
              />
            </Button>
          )}
          {canResume && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={handleResume}
              disabled={resuming}
              className="text-warning"
              title="Resume to evaluate deferred permission"
              aria-label="Resume to evaluate"
            >
              <Play data-icon="inline-start" />
              Resume
            </Button>
          )}
        </div>
      )}

      {archiveAction && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={archiveAction.run}
          className="absolute bottom-1.5 right-1.5 bg-background/80 text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:text-foreground"
          title={archiveAction.label}
          aria-label={archiveAction.label}
        >
          <archiveAction.icon data-icon="inline-start" />
        </Button>
      )}

      {proc && onKill && !isReadOnly && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={(event) => onKill(proc.pid, event)}
          disabled={killingPids.has(proc.pid)}
          className="absolute bottom-1.5 right-1.5 bg-background/80 text-destructive opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
          title={`Kill PID ${proc.pid}`}
          aria-label={`Kill process ${proc.pid}`}
        >
          <X data-icon="inline-start" />
        </Button>
      )}
    </div>
  )

  if (onDuplicateSession || onDeleteSession || onRenameSession || onArchiveSession || onUnarchiveSession) {
    return (
      <SessionContextMenu
        sessionLabel={s.slug || s.firstUserMessage?.slice(0, 30) || s.sessionId.slice(0, 12)}
        customName={customName}
        onDuplicate={onDuplicateSession ? () => onDuplicateSession(s.dirName, s.fileName) : undefined}
        onDelete={onDeleteSession ? () => onDeleteSession(s) : undefined}
        onRename={onRenameSession ? (name) => onRenameSession(s.sessionId, name) : undefined}
        onArchive={onArchiveSession && !isArchived ? () => onArchiveSession(s) : undefined}
        onUnarchive={onUnarchiveSession && isArchived ? () => onUnarchiveSession(s) : undefined}
        archiveDisabled={isLive}
      >
        {card}
      </SessionContextMenu>
    )
  }

  return card
}

function surface(isActive: boolean, justFinished: boolean): string {
  if (isActive) return "border-foreground/15 bg-accent"
  if (justFinished) return "border-success/30 bg-success/10"
  return "border-border/70 hover:border-border hover:bg-accent/50"
}
