import { X, MessageSquare, Cpu, GitBranch } from "lucide-react"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { SessionContextMenu } from "@/components/SessionContextMenu"
import { cn } from "@/lib/utils"
import {
  formatFileSize,
  formatRelativeTime,
  truncate,
} from "@/lib/format"
import { getStatusLabel } from "@/lib/sessionStatus"
import type { SessionStatus } from "@/lib/sessionStatus"
import { resolveTurnCount, turnCountColor } from "@/lib/turnCountCache"

export interface ActiveSessionInfo {
  dirName: string
  projectShortName: string
  fileName: string
  sessionId: string
  slug?: string
  firstUserMessage?: string
  lastUserMessage?: string
  gitBranch?: string
  cwd?: string
  lastModified: string
  lastActivityAt?: string
  turnCount?: number
  size: number
  isActive?: boolean
  matchedMessage?: string
  agentStatus?: SessionStatus
  agentToolName?: string
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
  onDuplicateSession?: (dirName: string, fileName: string) => void
  onDeleteSession?: (session: ActiveSessionInfo) => void
  onRenameSession?: (sessionId: string, name: string) => void
}

export function SessionRow({
  session: s,
  isActiveSession,
  proc,
  killingPids,
  isNewlyCompleted,
  customName,
  onSelectSession,
  onKill,
  onDuplicateSession,
  onDeleteSession,
  onRenameSession,
}: SessionRowProps) {
  const hasProcess = proc !== undefined
  const statusLabel = hasProcess
    ? (getStatusLabel(s.agentStatus, s.agentToolName) ?? "Idle")
    : null
  const turnCount = resolveTurnCount(s.sessionId, s.turnCount)
  const title = customName || truncate(s.lastUserMessage || s.firstUserMessage || s.slug || s.sessionId, 50)

  const sessionRow = (
    <Tooltip>
      <TooltipTrigger render={<div
          role="button"
          tabIndex={0}
          data-live-session
          onClick={() => onSelectSession(s.dirName, s.fileName)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelectSession(s.dirName, s.fileName) } }}
          className={cn(
            "group relative w-full flex items-center gap-1.5 rounded-md px-2 py-[7px] text-left transition-colors duration-100 cursor-pointer",
            cardStyle(isActiveSession, hasProcess && s.agentStatus === "completed" && !!isNewlyCompleted),
          )}
        />}>
          {/* Title */}
          <span className="text-xs leading-tight truncate flex-1 text-foreground">
            {title}
          </span>

          {/* Matched search snippet */}
          {s.matchedMessage && (
            <span className="text-[10px] text-amber-500/70 truncate max-w-[80px] italic shrink-0">
              {s.matchedMessage}
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
              onClick={(e) => onKill(proc.pid, e)}
              disabled={killingPids.has(proc.pid)}
              className="absolute top-0 right-0 opacity-0 group-hover:opacity-100 transition-opacity rounded-bl rounded-tr-md p-0.5 hover:bg-red-500/20 text-muted-foreground hover:text-red-400 disabled:opacity-50 z-10"
              title={`Kill PID ${proc.pid}`}
              aria-label={`Kill process ${proc.pid}`}
            >
              <X className="size-2.5" />
            </button>
          )}
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-[220px]">
        <div className="flex flex-col gap-0.5 text-[11px]">
          {statusLabel && (
            <span className={cn("font-medium", getStatusColor(s.agentStatus))}>
              {statusLabel}
            </span>
          )}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground">
            {s.gitBranch && (
              <span className="flex items-center gap-0.5">
                <GitBranch className="size-2.5" />
                {s.gitBranch}
              </span>
            )}
            <span>{formatFileSize(s.size)}</span>
            {hasProcess && (
              <span className="flex items-center gap-0.5 text-green-500">
                <Cpu className="size-2.5" />
                {proc.memMB} MB
              </span>
            )}
          </div>
        </div>
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

function isIdleStatus(status?: SessionStatus): boolean {
  return status === "idle" || status === "completed"
}

function getStatusColor(status?: SessionStatus): string {
  if (isIdleStatus(status)) return "text-green-400"
  if (status === "thinking") return "text-amber-400"
  return "text-blue-400"
}

