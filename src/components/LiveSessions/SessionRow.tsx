import { useState } from "react"
import { X, MessageSquare, GitBranch, Play, Bot, Users, ChevronRight } from "lucide-react"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { SessionContextMenu } from "@/components/SessionContextMenu"
import { cn } from "@/lib/utils"
import { formatRelativeTime } from "@/lib/format"
import { getStatusLabel } from "@/lib/sessionStatus"
import type { SessionStatus } from "@/lib/sessionStatus"
import { resolveTurnCount, turnCountColor } from "@/lib/turnCountCache"
import { SessionPreview, isIdleStatus, getStatusColor } from "./SessionPreview"
import { sessionTitle } from "./sessionListView"
import { useHoverPrefetch } from "./useHoverPrefetch"

export interface ActiveSessionInfo {
  dirName: string
  projectShortName: string
  fileName: string
  sessionId: string
  slug?: string
  /** AI-generated session title from Claude Code's ai-title JSONL events */
  aiTitle?: string
  firstUserMessage?: string
  lastUserMessage?: string
  gitBranch?: string
  cwd?: string
  lastModified: string
  lastActivityAt?: string
  turnCount?: number
  size: number
  isActive?: boolean
  agentStatus?: SessionStatus
  agentToolName?: string
  agentTerminalReason?: string
  /** Agent-team name when this session is a teammate's own session */
  teamName?: string
  /** Member name within the team (e.g. "cc-research") */
  agentName?: string
  /** Session ID of the team lead that spawned this teammate session */
  teamLeadSessionId?: string
}

export interface RunningProcess {
  pid: number
  memMB: number
  cpu: number
  sessionId: string | null
  tty: string
  args: string
  startTime: string
}

interface SessionRowProps {
  session: ActiveSessionInfo
  isActiveSession: boolean
  proc: RunningProcess | undefined
  killingPids: Set<number>
  onSelectSession: (dirName: string, fileName: string) => void
  onKill: (pid: number, e: React.MouseEvent) => void
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
        : getStatusLabel(s.agentStatus, s.agentToolName, s.agentTerminalReason) ?? "Running")
    : null
  const turnCount = resolveTurnCount(s.sessionId, s.turnCount)
  // Left-edge status dot: amber = needs attention, pulsing green = working,
  // solid green = live but idle/done. Recent (dead) sessions get no dot.
  const statusDot = isDeferred
    ? "bg-amber-400"
    : isLive
      ? isIdleStatus(s.agentStatus)
        ? "bg-green-400"
        : "bg-green-400 animate-pulse"
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
    <Tooltip>
      <TooltipTrigger render={<div
          role="button"
          tabIndex={0}
          data-live-session
          onClick={() => onSelectSession(s.dirName, s.fileName)}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault()
              onSelectSession(s.dirName, s.fileName)
            }
          }}
          onMouseEnter={handleHoverStart}
          onMouseLeave={handleHoverEnd}
          onFocus={handleHoverStart}
          onBlur={handleHoverEnd}
          className={cn(
            "group relative w-full flex items-center gap-1.5 rounded-md px-2 py-[7px] text-left transition-colors duration-100 cursor-pointer",
            cardStyle(isActiveSession, !isNativeLive && hasProcess && s.agentStatus === "completed" && !!isNewlyCompleted),
          )}
        />}>
          {/* Status dot — fixed-width slot so titles stay aligned when there's no dot */}
          <span className="flex w-1.5 shrink-0 items-center justify-center" aria-hidden="true">
            {statusDot && <span className={cn("size-1.5 rounded-full", statusDot)} />}
          </span>

          {/* Title */}
          <span className="text-xs leading-tight truncate flex-1 text-foreground">
            {title}
          </span>

          {/* Teammate badge — marks sessions spawned as agent-team members */}
          {isTeammate && (
            <span className="flex items-center gap-0.5 rounded bg-violet-500/10 text-violet-400 px-1 py-px text-[9px] font-medium shrink-0">
              <Bot className="size-2" />
              {title !== s.agentName && s.agentName}
            </span>
          )}

          {/* Native app-server turns have no killable OS process, but are live. */}
          {isLive && !isDeferred && statusLabel && (
            <span
              data-session-live-state
              className={cn(
                "flex items-center rounded px-1 py-px text-[9px] font-medium shrink-0",
                isNativeIdle
                  ? "bg-blue-500/10 text-blue-400"
                  : "bg-muted/60",
                !isNativeIdle && getStatusColor(s.agentStatus),
              )}
            >
              {statusLabel}
            </span>
          )}

          {/* Team collapse chip — on lead rows with nested teammate sessions */}
          {!!teammateCount && onToggleTeammates && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onToggleTeammates() }}
              className="flex items-center gap-0.5 rounded bg-violet-500/10 text-violet-400 hover:bg-violet-500/20 hover:text-violet-300 px-1 py-px text-[9px] font-medium shrink-0 transition-colors"
              title={teammatesCollapsed ? "Show team agents" : "Hide team agents"}
              aria-label={teammatesCollapsed ? `Show ${teammateCount} team agents` : `Hide ${teammateCount} team agents`}
              aria-expanded={!teammatesCollapsed}
            >
              <Users className="size-2" />
              {teammateCount}
              <ChevronRight className={cn(
                "size-2 transition-transform duration-150",
                !teammatesCollapsed && "rotate-90"
              )} />
            </button>
          )}

          {/* Deferred pill + resume button */}
          {isDeferred && (
            <>
              <span className="flex items-center rounded bg-amber-500/15 text-amber-400 px-1 py-px text-[9px] font-medium shrink-0">
                deferred
              </span>
              {onResumeSession && (
                <button
                  type="button"
                  onClick={handleResume}
                  disabled={resuming}
                  className="flex items-center gap-0.5 rounded bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 hover:text-amber-300 px-1 py-px text-[9px] font-medium shrink-0 transition-colors disabled:opacity-50"
                  title="Resume to evaluate deferred permission"
                  aria-label="Resume to evaluate"
                >
                  <Play className="size-2 fill-current" />
                  Resume
                </button>
              )}
            </>
          )}

          {/* Worktree badge */}
          {worktreeName && (
            <span className="flex items-center gap-0.5 rounded bg-emerald-500/10 text-emerald-400 px-1 py-px text-[9px] font-medium shrink-0">
              <GitBranch className="size-2" />
              {worktreeName}
            </span>
          )}

          {/* Turn count */}
          {turnCount > 0 && (
            <span className={cn(
              "flex items-center gap-0.5 text-[11px] font-medium shrink-0",
              turnCountColor(turnCount)
            )}>
              <MessageSquare className="size-2.5" />
              {turnCount}
            </span>
          )}

          {/* Relative time */}
          <span className="text-[11px] text-muted-foreground shrink-0 tabular-nums">
            {formatRelativeTime(s.lastActivityAt || s.lastModified)}
          </span>

          {/* Kill button — absolute badge, no layout space */}
          {hasProcess && (
            <button
              type="button"
              onClick={(e) => onKill(proc.pid, e)}
              disabled={killingPids.has(proc.pid)}
              className="absolute top-0 right-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition-opacity rounded-bl rounded-tr-md p-0.5 hover:bg-red-500/20 text-muted-foreground hover:text-red-400 disabled:opacity-50 z-10"
              title={`Kill PID ${proc.pid}`}
              aria-label={`Kill process ${proc.pid}`}
            >
              <X className="size-2.5" />
            </button>
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
  if (isActive) return "border-l-2 border-l-blue-500 rounded-l-none"
  if (isNewlyCompleted) return "border-l-2 border-l-green-500 rounded-l-none"
  return "hover:bg-white/[0.03]"
}
