import { Bot, ChevronRight, Clock, GitBranch, GitFork, MessagesSquare, Trees } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { PullRequestChips } from "@/components/PullRequestChips"
import { getStatusColor, isIdleStatus } from "@/components/LiveSessions/sessionStatusPresentation"
import { STATUS_DOT } from "@/components/LiveSessions/statusDot"
import { getStatusLabel, getTerminalReasonLabel } from "../../../shared/session/sessionStatus"
import {
  formatDuration,
  formatFileSize,
  formatRelativeTime,
  parseWorktreePath,
  shortenModel,
  truncate,
} from "@/lib/format"
import { cn } from "@/lib/utils"
import { isRecentlyActive, sessionPreviewText, sessionRowTitle } from "./sessionPresentation"
import type { SessionInfo } from "./types"

/** How long the session ran, first prompt to last activity. */
function sessionSpan(start: string | undefined, end: string | null): string | null {
  if (!start || !end) return null
  const ms = new Date(end).getTime() - new Date(start).getTime()
  return ms >= 60_000 ? formatDuration(ms) : null
}

/** Everything too fine-grained for the row itself, shown on hover. */
function detailTooltip(session: SessionInfo): string {
  const lines = [session.sessionId]
  if (session.cwd) lines.push(session.cwd)
  if (session.version) lines.push(`CLI ${session.version}`)
  if (session.timestamp) lines.push(`Started ${new Date(session.timestamp).toLocaleString()}`)
  return lines.join("\n")
}

/** Where the work happened — a worktree name places it better than the branch does. */
function workLocation(session: SessionInfo): { icon: LucideIcon; label: string; title?: string } | null {
  const worktree = session.cwd ? parseWorktreePath(session.cwd)?.worktreeName : undefined
  if (worktree) return { icon: Trees, label: worktree, title: session.cwd }
  if (session.gitBranch) return { icon: GitBranch, label: session.gitBranch }
  return null
}

/** Recent sessions get a dot; a finished one has nothing left to signal. */
function statusDot(session: SessionInfo, live: boolean): keyof typeof STATUS_DOT | null {
  if (session.agentStatus === "deferred") return "attention"
  if (!live) return null
  return isIdleStatus(session.agentStatus) ? "idle" : "working"
}

/**
 * A live session reports what it is doing; a finished one only speaks up when
 * it ended badly, which is the case worth scanning a long list for.
 */
function StatusBadge({ session, live }: { session: SessionInfo; live: boolean }) {
  if (session.agentStatus === "deferred") {
    return (
      <Badge variant="outline" className="border-warning/30 bg-warning/10 text-warning">
        Needs review
      </Badge>
    )
  }

  if (live) {
    const idle = isIdleStatus(session.agentStatus)
    const label = getStatusLabel(
      session.agentStatus,
      session.agentToolName,
      session.agentTerminalReason,
      session.agentPendingAgents,
    ) ?? "Active"
    return (
      <Badge variant="secondary" className={getStatusColor(session.agentStatus)}>
        <span
          aria-hidden="true"
          data-icon="inline-start"
          className={cn("size-1.5 rounded-full", idle ? "bg-success/60" : "bg-current")}
        />
        {label}
      </Badge>
    )
  }

  if (session.agentTerminalReason) {
    return (
      <Badge variant="outline" className="max-w-44 truncate text-warning">
        {getTerminalReasonLabel(session.agentTerminalReason)}
      </Badge>
    )
  }

  return null
}

interface MetaItemProps {
  icon: LucideIcon
  title?: string
  className?: string
  children: React.ReactNode
}

/** One icon-and-value entry in the row's bottom metadata line. */
function MetaItem({ icon: Icon, title, className, children }: MetaItemProps) {
  return (
    <span className={cn("flex items-center gap-1", className)} title={title}>
      <Icon className="size-3 shrink-0" />
      {children}
    </span>
  )
}

interface SessionListRowProps {
  session: SessionInfo
  customName?: string
  onSelect: () => void
}

export function SessionListRow({ session, customName, onSelect }: SessionListRowProps) {
  const lastActivity = session.lastActivityAt || session.lastModified
  const live = isRecentlyActive(lastActivity)
  const dot = statusDot(session, live)
  const teammateName = session.teamName ? session.agentName : undefined
  const location = workLocation(session)
  const span = sessionSpan(session.timestamp, lastActivity)
  const turnCount = session.turnCount ?? 0

  const title = sessionRowTitle(session, customName)
  const preview = sessionPreviewText(session, title)

  return (
    // The pull-request chips are links, which a <button> may not contain, so the
    // row shell is a plain element and the button covers only its own content.
    <div className="motion-list-item group flex w-full items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/50 focus-within:bg-muted">
      <button
        type="button"
        onClick={onSelect}
        title={detailTooltip(session)}
        className="flex min-w-0 flex-1 items-start gap-3 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="relative mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground">
          <MessagesSquare className="size-4" />
          {dot && (
            <span
              aria-hidden="true"
              data-status-dot={dot}
              className={cn("absolute -top-1 -right-1 size-2 rounded-full ring-2 ring-card", STATUS_DOT[dot])}
            />
          )}
        </span>

        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium">{title}</span>
            {teammateName && (
              <Badge variant="outline" className="shrink-0">
                <Bot data-icon="inline-start" />
                {truncate(teammateName, 18)}
              </Badge>
            )}
            {session.branchedFrom && (
              <Badge variant="outline" className="shrink-0" title="Branched from another session">
                <GitFork data-icon="inline-start" />
                branch
              </Badge>
            )}

            <span className="ml-auto flex shrink-0 items-center gap-2">
              <StatusBadge session={session} live={live} />
              {lastActivity && (
                <span className="text-xs tabular-nums text-muted-foreground">
                  {formatRelativeTime(lastActivity)}
                </span>
              )}
            </span>
          </span>

          {preview && (
            <span className="line-clamp-1 text-sm text-muted-foreground">{preview}</span>
          )}

          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {session.model && <Badge variant="outline">{shortenModel(session.model)}</Badge>}
            {turnCount > 0 && (
              <MetaItem icon={MessagesSquare}>
                {turnCount} {turnCount === 1 ? "turn" : "turns"}
              </MetaItem>
            )}
            {span && (
              <MetaItem icon={Clock} title="First prompt to last activity">
                {span}
              </MetaItem>
            )}
            {location && (
              <MetaItem icon={location.icon} className="max-w-40 truncate" title={location.title}>
                {truncate(location.label, 22)}
              </MetaItem>
            )}
            <span>{formatFileSize(session.size)}</span>
          </span>
        </span>
      </button>

      <span className="flex shrink-0 items-center gap-2 pt-1.5">
        {session.matchedPullRequestNumber ? (
          <Badge variant="outline">Matched #{session.matchedPullRequestNumber}</Badge>
        ) : (
          <PullRequestChips pullRequests={session.pullRequests} max={2} compact />
        )}
        <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </span>
    </div>
  )
}
