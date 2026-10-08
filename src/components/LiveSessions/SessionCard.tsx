import { useState } from "react"
import {
  Archive,
  ArchiveRestore,
  ArrowUp,
  Bot,
  ChevronRight,
  Folder,
  GitBranch,
  MessageSquare,
  Play,
  Users,
  X,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ProjectFavicon } from "@/components/ProjectFavicon"
import { PullRequestChips } from "@/components/PullRequestChips"
import { SessionContextMenu } from "@/components/SessionContextMenu"
import { SessionBadges } from "@/components/shared/SessionBadges"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { formatRelativeTime } from "@/lib/format"
import { resolveTurnCount } from "@/lib/turnCountCache"
import { getStatusColor } from "./sessionStatusPresentation"
import { archivedReasonLabel, isUntitledSession, sessionHeadline } from "./sessionListView"
import { describeSessionRow } from "./sessionRowState"
import { SessionPreview } from "./SessionPreview"
import type { SessionRowProps } from "./SessionRow"
import { STATUS_DOT } from "./statusDot"
import { useHoverPrefetch } from "./useHoverPrefetch"
import { CrewFold } from "./CrewFold"
import type { CrewCounts, MemberStatus } from "./crew"
import type { ActiveSessionInfo } from "./types"
import { getSessionRecencyMs } from "../../../shared/session-ordering"
import { isRecentlyActive } from "@/lib/sessionActivity"

const EMPTY_NAMES: Record<string, string> = {}

type SessionCardProps = SessionRowProps & {
  projectLabel?: string
  /** Where the project's icon comes from; the card falls back to a folder. */
  projectPath?: string
  /**
   * Print the project above the title. On when the list mixes projects, so
   * every card says where it belongs; off when the list is one project, where
   * the preview still names it.
   */
  showProject?: boolean
  /** The crew riding with this session: the card closes with its line, and its dot and time are the crew's. */
  crew?: CardCrew
  /** For a crew member listed on its own: who started it, in place of the project. */
  lineage?: CardLineage
  sessionNames?: Record<string, string>
  activeSessionKey?: string | null
}

export interface CardCrew {
  members: ActiveSessionInfo[]
  counts: CrewCounts
  statusOf: (member: ActiveSessionInfo) => MemberStatus
  /** When the session or any member last did something. */
  activityAt: string
  open: boolean
  onToggle: () => void
}

export interface CardLineage {
  parentTitle: string
  /** The crew's root, when it is not the parent. */
  rootTitle?: string
  onOpenParent: () => void
}

/**
 * A session with room to breathe: the sidebar's row expanded into a card with
 * the last prompt and vitals, the same actions as the row, and a hover
 * preview with the full prompts for when that is still not enough.
 */
export function SessionCard({
  session: s,
  projectLabel,
  projectPath,
  showProject,
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
  crew,
  lineage,
  sessionNames = EMPTY_NAMES,
  activeSessionKey = null,
}: SessionCardProps) {
  const {
    isLive,
    isRunning,
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
  const untitled = isUntitledSession(s, customName)
  const projectEyebrow = showProject && !lineage ? projectLabel : undefined
  const shownDot = crewDot(crew?.counts, dotState)
  const crewIsAhead = crew !== undefined
    && Date.parse(crew.activityAt) > getSessionRecencyMs(s)
  const lastPrompt = s.lastUserMessage || s.firstUserMessage
  const showPrompt = Boolean(lastPrompt) && lastPrompt !== headline
  const turnCount = resolveTurnCount(s.sessionId, s.turnCount)
  const archivedLabel = archivedReasonLabel(s.archivedReason)
  const archiveAction = isArchived
    ? onUnarchiveSession && { label: "Restore from archive", icon: ArchiveRestore, run: () => onUnarchiveSession(s) }
    : onArchiveSession && !isRunning && { label: "Archive session", icon: Archive, run: () => onArchiveSession(s) }
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
      {lineage && (
        <button
          type="button"
          data-crew-lineage
          onClick={lineage.onOpenParent}
          aria-label={`Open ${lineage.parentTitle}, which started this session`}
          className="flex min-w-0 items-center gap-1.5 rounded-t-lg px-3 pl-[26px] pt-2.5 text-left text-[11px] leading-tight outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowUp className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="truncate text-foreground/90">{lineage.parentTitle}</span>
          {lineage.rootTitle && (
            <span className="truncate text-muted-foreground">· {lineage.rootTitle}</span>
          )}
        </button>
      )}
      <Tooltip>
        <TooltipTrigger
          render={
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
                "flex w-full flex-col gap-1.5 rounded-lg px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                lineage ? "pt-1" : "pt-2.5",
                hasFooter || crew ? "pb-1.5" : "pb-2.5",
              )}
            />
          }
        >
        {projectEyebrow && (
          <span
            data-session-project
            className="flex items-center gap-1.5 pl-3.5 text-[11px] leading-tight text-muted-foreground"
          >
            <ProjectFavicon
              projectPath={projectPath}
              fallback={<Folder className="size-3 shrink-0" aria-hidden="true" />}
              className="size-3"
            />
            <span className="truncate">{projectEyebrow}</span>
          </span>
        )}
        <span className="flex items-start gap-2">
          <span className="mt-[7px] flex w-1.5 shrink-0 justify-center" aria-hidden="true">
            {shownDot && (
              <span
                data-status-dot={shownDot}
                className={cn("size-1.5 rounded-full", STATUS_DOT[shownDot])}
              />
            )}
          </span>
          <span
            className={cn(
              "line-clamp-2 flex-1 text-sm leading-snug",
              untitled ? "text-muted-foreground" : "font-medium text-foreground",
            )}
          >
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
          <SessionBadges access={s.access} />
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
          {crewIsAhead ? (
            <span
              data-crew-activity
              className={cn("ml-auto tabular-nums", isRecentlyActive({ ...s, lastActivityAt: crew.activityAt }) && "text-success")}
            >
              crew active {formatRelativeTime(crew.activityAt)}
            </span>
          ) : (
            <span className="ml-auto tabular-nums">
              {formatRelativeTime(s.lastActivityAt || s.lastModified)}
            </span>
          )}
        </span>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-[320px]">
          <SessionPreview
            session={s}
            proc={proc}
            statusLabel={statusLabel}
            customName={customName}
            worktreeName={worktreeName}
            projectLabel={projectEyebrow ? undefined : projectLabel}
          />
        </TooltipContent>
      </Tooltip>

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

      {crew && (
        <CrewFold
          host={s}
          members={crew.members}
          counts={crew.counts}
          statusOf={crew.statusOf}
          open={crew.open}
          onToggle={crew.onToggle}
          sessionNames={sessionNames}
          activeSessionKey={activeSessionKey}
          onSelectSession={onSelectSession}
        />
      )}

      {archiveAction && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={archiveAction.run}
          className={cn(
            "absolute right-1.5 bg-popover text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:text-foreground",
            crew ? "top-1.5" : "bottom-1.5",
          )}
          title={archiveAction.label}
          aria-label={archiveAction.label}
        >
          <archiveAction.icon data-icon="inline-start" />
        </Button>
      )}

      {proc && onKill && isRunning && !isArchived && !isReadOnly && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={(event) => onKill(proc.pid, event)}
          disabled={killingPids.has(proc.pid)}
          className={cn(
            "absolute right-1.5 bg-popover text-destructive opacity-0 group-focus-within:opacity-100 group-hover:opacity-100",
            crew ? "top-1.5" : "bottom-1.5",
          )}
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
        archiveDisabled={isRunning}
      >
        {card}
      </SessionContextMenu>
    )
  }

  return card
}

/** A crew's root wears the crew's state: someone waiting outranks someone working. */
function crewDot(
  counts: CrewCounts | undefined,
  own: keyof typeof STATUS_DOT | null,
): keyof typeof STATUS_DOT | null {
  if (!counts) return own
  if (counts.needsYou > 0 || own === "attention") return "attention"
  if (counts.working > 0) return "working"
  return own
}

function surface(isActive: boolean, justFinished: boolean): string {
  if (isActive) return "border-foreground/15 bg-accent"
  if (justFinished) return "border-success/30 bg-success/10"
  return "border-border/70 bg-card hover:border-border hover:bg-accent"
}
