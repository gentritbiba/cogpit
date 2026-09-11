import { Archive, Cpu, Folder, GitBranch, MessageSquare, Users } from "lucide-react"
import { PullRequestChips } from "@/components/PullRequestChips"
import { cn } from "@/lib/utils"
import { formatFileSize, formatRelativeTime } from "@/lib/format"
import { resolveTurnCount } from "@/lib/turnCountCache"
import { getStatusColor } from "./sessionStatusPresentation"
import { archivedReasonLabel } from "./sessionListView"
import type { ActiveSessionInfo, RunningProcess } from "./types"

interface SessionPreviewProps {
  session: ActiveSessionInfo
  proc?: RunningProcess
  statusLabel?: string | null
  customName?: string
  worktreeName?: string
  /** The project, for lists that do not print it on the row itself. */
  projectLabel?: string
}

/**
 * Rich hover preview shared by session cards, rows and attention-strip rows:
 * the full title, project, current status, how the session started and where
 * it is now, and its vitals — enough to decide whether to switch without
 * opening the session.
 */
export function SessionPreview({
  session: s,
  proc,
  statusLabel,
  customName,
  worktreeName,
  projectLabel,
}: SessionPreviewProps) {
  const fullTitle = customName || s.aiTitle
  const firstPrompt = s.firstUserMessage
  const lastPrompt = s.lastUserMessage && s.lastUserMessage !== firstPrompt ? s.lastUserMessage : undefined
  // Resolved against the client cache so a live session's count stays accurate.
  const turnCount = resolveTurnCount(s.sessionId, s.turnCount)

  return (
    <div className="flex w-72 flex-col gap-2 text-xs">
      {fullTitle && (
        <span className="font-medium leading-snug text-foreground">{fullTitle}</span>
      )}
      {projectLabel && (
        <span className="flex items-center gap-1 text-muted-foreground">
          <Folder className="size-3 shrink-0" />
          <span className="truncate">{projectLabel}</span>
        </span>
      )}
      {statusLabel && (
        <span className={cn("font-medium", getStatusColor(s.agentStatus))}>
          {statusLabel}
        </span>
      )}
      {s.teamName && s.agentName && (
        <span className="flex items-center gap-1 text-muted-foreground">
          <Users className="size-3" />
          {s.agentName} · {s.teamName}
        </span>
      )}
      {s.archived && (
        <span className="flex items-center gap-1 text-muted-foreground">
          <Archive className="size-3" />
          {archivedReasonLabel(s.archivedReason)}
        </span>
      )}
      {firstPrompt && (
        <div className="flex flex-col gap-0.5">
          {lastPrompt && <span className="text-[10px] text-muted-foreground/70">Started with</span>}
          <div className="border-l-2 pl-2 text-muted-foreground">
            <span data-first-prompt className="line-clamp-8 leading-relaxed">{firstPrompt}</span>
          </div>
        </div>
      )}
      {lastPrompt && (
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground/70">Latest</span>
          <div className="border-l-2 pl-2 text-muted-foreground">
            <span data-last-prompt className="line-clamp-4 leading-relaxed">{lastPrompt}</span>
          </div>
        </div>
      )}
      <PullRequestChips pullRequests={s.pullRequests} layout="list" />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground">
        {s.gitBranch && (
          <span className="flex items-center gap-0.5">
            <GitBranch className="size-2.5" />
            {worktreeName ? `${s.gitBranch} · ${worktreeName}` : s.gitBranch}
          </span>
        )}
        {turnCount > 0 && (
          <span className="flex items-center gap-0.5">
            <MessageSquare className="size-2.5" />
            {turnCount} {turnCount === 1 ? "turn" : "turns"}
          </span>
        )}
        <span>{formatFileSize(s.size)}</span>
        {proc && (
          <span className="flex items-center gap-0.5 text-success">
            <Cpu className="size-2.5" />
            {proc.memMB} MB
          </span>
        )}
        <span>{formatRelativeTime(s.lastActivityAt || s.lastModified)}</span>
      </div>
    </div>
  )
}
