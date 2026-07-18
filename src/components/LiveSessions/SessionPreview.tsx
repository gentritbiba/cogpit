import { Cpu, GitBranch, MessageSquare, Users } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatFileSize, formatRelativeTime } from "@/lib/format"
import type { SessionStatus } from "@/lib/sessionStatus"
import type { ActiveSessionInfo, RunningProcess } from "./SessionRow"

export function isIdleStatus(status?: SessionStatus): boolean {
  return status === "idle" || status === "completed"
}

export function getStatusColor(status?: SessionStatus): string {
  if (isIdleStatus(status)) return "text-green-400"
  if (status === "thinking" || status === "deferred") return "text-amber-400"
  return "text-blue-400"
}

interface SessionPreviewProps {
  session: ActiveSessionInfo
  proc?: RunningProcess
  statusLabel?: string | null
  customName?: string
  worktreeName?: string
}

/**
 * Rich hover preview shared by session rows and attention-strip rows: the
 * full title, current status, the last prompt, and session vitals — enough
 * to decide whether to switch without opening the session.
 */
export function SessionPreview({
  session: s,
  proc,
  statusLabel,
  customName,
  worktreeName,
}: SessionPreviewProps) {
  const fullTitle = customName || s.aiTitle
  const lastPrompt = s.lastUserMessage || s.firstUserMessage
  const turnCount = s.turnCount ?? 0

  return (
    <div className="flex w-64 flex-col gap-1.5 text-[11px]">
      {fullTitle && (
        <span className="font-medium leading-snug text-foreground">{fullTitle}</span>
      )}
      {statusLabel && (
        <span className={cn("font-medium", getStatusColor(s.agentStatus))}>
          {statusLabel}
        </span>
      )}
      {s.teamName && s.agentName && (
        <span className="flex items-center gap-1 text-violet-400">
          <Users className="size-2.5" />
          {s.agentName} · {s.teamName}
        </span>
      )}
      {lastPrompt && (
        <div className="border-l-2 border-border/60 pl-1.5 text-muted-foreground">
          <span className="line-clamp-3 italic leading-snug">{lastPrompt}</span>
        </div>
      )}
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
            {turnCount} turns
          </span>
        )}
        <span>{formatFileSize(s.size)}</span>
        {proc && (
          <span className="flex items-center gap-0.5 text-green-500">
            <Cpu className="size-2.5" />
            {proc.memMB} MB
          </span>
        )}
        <span>{formatRelativeTime(s.lastActivityAt || s.lastModified)}</span>
      </div>
    </div>
  )
}
