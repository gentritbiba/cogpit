import { useState } from "react"
import { X, GitBranch, Play, Bot, Users, ChevronRight } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { PullRequestChips } from "@/components/PullRequestChips"
import { SessionContextMenu } from "@/components/SessionContextMenu"
import { cn } from "@/lib/utils"
import { formatRelativeTime } from "@/lib/format"
import { getStatusLabel } from "@/lib/sessionStatus"
import { SessionPreview } from "./SessionPreview"
import { getStatusColor, isIdleStatus } from "./sessionStatusPresentation"
import { sessionTitle } from "./sessionListView"
import { STATUS_DOT } from "./statusDot"
import { useHoverPrefetch } from "./useHoverPrefetch"
import type { ActiveSessionInfo, RunningProcess } from "./types"

interface SessionRowProps {
  session: ActiveSessionInfo
  isActiveSession: boolean
  proc: RunningProcess | undefined
  killingPids: Set<number>
  onSelectSession: (dirName: string, fileName: string) => void
  onKill?: (pid: number, e: React.MouseEvent) => void
  isNewlyCompleted?: boolean
  customName?: string
  /** When set, this session belongs to a git worktree — shows an indicator badge. */
  worktreeName?: string
  /** Number of teammate sessions nested under this lead — shows a collapse chip. */
  teammateCount?: number
  /** Whether the nested teammate group is currently collapsed. */
  teammatesCollapsed?: boolean
  /** Toggles the nested teammate group open/closed. */
  onToggleTeammates?: () => void
  onDuplicateSession?: (dirName: string, fileName: string) => void
  onDeleteSession?: (session: ActiveSessionInfo) => void
  onRenameSession?: (sessionId: string, name: string) => void
  /**
   * Called after the user hovers or focuses the row for ~120ms. Should warm the
   * session cache so the subsequent click dispatches synchronously. Optional
   * — rows without this prop behave exactly as before.
   */
  onPrefetchSession?: (dirName: string, fileName: string) => void
  /**
   * Called when the user clicks "Resume to evaluate" on a deferred session.
   * The parent should spawn `claude -p --resume <sessionId>` in the session's cwd.
   */
  onResumeSession?: (sessionId: string, cwd?: string) => void
}

export function SessionRow({
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
  onRenameSession,
  onPrefetchSession,
  onResumeSession,
}: SessionRowProps) {
  const hasProcess = proc !== undefined
  const isNativeLive = s.isActive === true
  const isLive = hasProcess || isNativeLive
  const isNativeIdle = isNativeLive && isIdleStatus(s.agentStatus)
  const isDeferred = s.agentStatus === "deferred"
  const [resuming, setResuming] = useState(false)
  const statusLabel = isLive
    ? (isNativeIdle
        ? "Running"
        : getStatusLabel(s.agentStatus, s.agentToolName, s.agentTerminalReason, s.agentPendingAgents) ?? "Running")
    : null
  // Left-edge status dot. Recent (dead) sessions get no dot.
  const dotState = isDeferred
    ? "attention"
    : isLive
      ? isIdleStatus(s.agentStatus) ? "idle" : "working"
      : null
  const isTeammate = !!(s.teamName && s.agentName)
  const title = sessionTitle(s, customName)

  // Hover-intent prefetch: warm the session cache after a short dwell. Fires
  // on focus too so keyboard users benefit.
  const { onHoverStart: handleHoverStart, onHoverEnd: handleHoverEnd } = useHoverPrefetch(
    onPrefetchSession && !isActiveSession
      ? () => onPrefetchSession(s.dirName, s.fileName)
      : undefined,
  )

  const handleResume = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!onResumeSession || resuming) return
    setResuming(true)
    onResumeSession(s.sessionId, s.cwd)
    // Reset after 3 s in case parent doesn't unmount the row immediately
    setTimeout(() => setResuming(false), 3000)
  }

  const sessionRow = (
    <div
      className={cn(
        "motion-list-item group relative flex min-h-9 w-full items-center gap-1.5 rounded-md px-2.5 py-2 transition-colors",
        cardStyle(isActiveSession, !isNativeLive && hasProcess && s.agentStatus === "completed" && !!isNewlyCompleted),
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              data-live-session
              onClick={() => onSelectSession(s.dirName, s.fileName)}
              onMouseEnter={handleHoverStart}
              onMouseLeave={handleHoverEnd}
              onFocus={handleHoverStart}
              onBlur={handleHoverEnd}
              className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        >
          <span className="flex w-1.5 shrink-0 items-center justify-center" aria-hidden="true">
            {dotState && (
              <span data-status-dot={dotState} className={cn("size-1.5 rounded-full", STATUS_DOT[dotState])} />
            )}
          </span>
          <span className="flex-1 truncate text-sm leading-tight text-foreground">{title}</span>
          {isTeammate && (
            <Badge variant="outline">
              <Bot data-icon="inline-start" />
              {title !== s.agentName ? s.agentName : "Agent"}
            </Badge>
          )}
          {isLive && !isDeferred && statusLabel && (
            <Badge
              variant="secondary"
              data-session-live-state
              className={cn(
                "shrink-0",
                isNativeIdle && "text-success",
                !isNativeIdle && getStatusColor(s.agentStatus),
              )}
            >
              {statusLabel}
            </Badge>
          )}
          {isDeferred && (
            <Badge variant="outline" className="border-warning/30 bg-warning/10 text-warning">
              deferred
            </Badge>
          )}
          {worktreeName && (
            <Badge variant="outline">
              <GitBranch data-icon="inline-start" />
              {worktreeName}
            </Badge>
          )}
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-[280px]">
          <SessionPreview
            session={s}
            proc={proc}
            statusLabel={statusLabel}
            customName={customName}
            worktreeName={worktreeName}
          />
        </TooltipContent>
      </Tooltip>

      {!!teammateCount && onToggleTeammates && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={onToggleTeammates}
          className="shrink-0"
          title={teammatesCollapsed ? "Show team agents" : "Hide team agents"}
          aria-label={teammatesCollapsed ? `Show ${teammateCount} team agents` : `Hide ${teammateCount} team agents`}
          aria-expanded={!teammatesCollapsed}
        >
          <Users data-icon="inline-start" />
          {teammateCount}
          <ChevronRight data-icon="inline-end" className={cn(
            "transition-transform duration-150",
            !teammatesCollapsed && "rotate-90"
          )} />
        </Button>
      )}

      {isDeferred && onResumeSession && (
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={handleResume}
          disabled={resuming}
          className="shrink-0 text-warning"
          title="Resume to evaluate deferred permission"
          aria-label="Resume to evaluate"
        >
          <Play data-icon="inline-start" />
          Resume
        </Button>
      )}

      <PullRequestChips pullRequests={s.pullRequests} max={1} compact />
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {formatRelativeTime(s.lastActivityAt || s.lastModified)}
      </span>

      {hasProcess && onKill && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={(event) => onKill(proc.pid, event)}
          disabled={killingPids.has(proc.pid)}
          className="absolute right-0 top-0 text-destructive opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
          title={`Kill PID ${proc.pid}`}
          aria-label={`Kill process ${proc.pid}`}
        >
          <X data-icon="inline-start" />
        </Button>
      )}
    </div>
  )

  if (onDuplicateSession || onDeleteSession || onRenameSession) {
    return (
      <SessionContextMenu
        sessionLabel={s.slug || s.firstUserMessage?.slice(0, 30) || s.sessionId.slice(0, 12)}
        customName={customName}
        onDuplicate={onDuplicateSession ? () => onDuplicateSession(s.dirName, s.fileName) : undefined}
        onDelete={onDeleteSession ? () => onDeleteSession(s) : undefined}
        onRename={onRenameSession ? (name) => onRenameSession(s.sessionId, name) : undefined}
      >
        {sessionRow}
      </SessionContextMenu>
    )
  }

  return sessionRow
}

// -- Helpers --

function cardStyle(isActive: boolean, isNewlyCompleted: boolean): string {
  if (isActive) return "bg-accent"
  if (isNewlyCompleted) return "bg-success/10"
  return "hover:bg-accent/60"
}
