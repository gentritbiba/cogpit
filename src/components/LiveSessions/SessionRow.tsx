import { X, GitBranch, MessageSquare, Cpu } from "lucide-react"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { SessionContextMenu } from "@/components/SessionContextMenu"
import { cn } from "@/lib/utils"
import {
  formatFileSize,
  formatRelativeTime,
  truncate,
  shortPath,
  dirNameToPath,
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
  onDuplicateSession?: (dirName: string, fileName: string) => void
  onDeleteSession?: (session: ActiveSessionInfo) => void
}

export function SessionRow({
  session: s,
  isActiveSession,
  proc,
  killingPids,
  onSelectSession,
  onKill,
  onDuplicateSession,
  onDeleteSession,
}: SessionRowProps) {
  const hasProcess = proc !== undefined
  const statusLabel = hasProcess
    ? (getStatusLabel(s.agentStatus, s.agentToolName) ?? "Idle")
    : null
  const turnCount = resolveTurnCount(s.sessionId, s.turnCount)

  const sessionRow = (
    <div
      role="button"
      tabIndex={0}
      data-live-session
      onClick={() => onSelectSession(s.dirName, s.fileName)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelectSession(s.dirName, s.fileName) } }}
      className={cn(
        "group relative w-full flex flex-col gap-1 rounded-lg px-2.5 py-2.5 text-left transition-colors duration-150 cursor-pointer card-hover",
        isActiveSession
          ? "bg-blue-500/10 ring-1 ring-blue-500/50 shadow-[0_0_16px_-3px_rgba(59,130,246,0.25)]"
          : "elevation-1 border border-border/40 hover:bg-elevation-2"
      )}
    >
      {/* Top row: status dot + last prompt + kill button */}
      <div className="flex items-center gap-2">
        <StatusDot hasProcess={hasProcess} agentStatus={s.agentStatus} />
        <span className="text-xs font-medium truncate flex-1 text-foreground">
          {s.lastUserMessage || s.firstUserMessage || s.slug || truncate(s.sessionId, 16)}
        </span>
        {hasProcess ? (
          <button
            onClick={(e) => onKill(proc.pid, e)}
            disabled={killingPids.has(proc.pid)}
            className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity rounded p-0.5 hover:bg-red-500/20 text-muted-foreground hover:text-red-400 disabled:opacity-50"
            title={`Kill PID ${proc.pid} (${proc.memMB} MB)`}
            aria-label={`Kill process ${proc.pid}`}
          >
            <X className="size-3" />
          </button>
        ) : (
          <span className="font-mono text-xs text-muted-foreground shrink-0">
            #{s.sessionId.slice(0, 5)}
          </span>
        )}
      </div>

      {/* Project path */}
      <div className={cn(
        "ml-5.5 text-[10px]",
        isActiveSession ? "text-blue-400/70" : "text-muted-foreground"
      )}>
        {shortPath(s.cwd ?? dirNameToPath(s.dirName), 2)}
      </div>

      {/* Matched message snippet (search results) */}
      {s.matchedMessage && (
        <div className="ml-5.5 text-[10px] text-amber-500/70 truncate italic">
          {s.matchedMessage}
        </div>
      )}

      {/* Meta row */}
      <div className="ml-5.5 flex items-center gap-2 text-[10px] flex-wrap text-muted-foreground">
        {statusLabel && (
          <span className={cn(
            "flex items-center gap-0.5 font-medium",
            getStatusColor(s.agentStatus)
          )}>
            {statusLabel}
          </span>
        )}
        {turnCount > 0 && (
          <span className={cn(
            "flex items-center gap-0.5 text-[11px] font-semibold",
            turnCountColor(turnCount)
          )}>
            <MessageSquare className="size-3" />
            {turnCount}
          </span>
        )}
        {s.gitBranch && (
          <span className="flex items-center gap-0.5">
            <GitBranch className="size-2.5" />
            {s.gitBranch}
          </span>
        )}
        <span>{formatFileSize(s.size)}</span>
        <span>{formatRelativeTime(s.lastModified)}</span>
        {hasProcess && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex items-center gap-0.5 text-green-500">
                <Cpu className="size-2.5" />
                {proc.memMB} MB
              </span>
            </TooltipTrigger>
            <TooltipContent>RAM usage for this session</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  )

  if (onDuplicateSession || onDeleteSession) {
    return (
      <SessionContextMenu
        sessionLabel={s.slug || s.firstUserMessage?.slice(0, 30) || s.sessionId.slice(0, 12)}
        onDuplicate={onDuplicateSession ? () => onDuplicateSession(s.dirName, s.fileName) : undefined}
        onDelete={onDeleteSession ? () => onDeleteSession(s) : undefined}
      >
        {sessionRow}
      </SessionContextMenu>
    )
  }

  return <>{sessionRow}</>
}

// ── Helpers ──────────────────────────────────────────────────────────

function isIdleStatus(status?: SessionStatus): boolean {
  return status === "idle" || status === "completed"
}

function getStatusColor(status?: SessionStatus): string {
  if (isIdleStatus(status)) return "text-green-400"
  if (status === "thinking") return "text-amber-400"
  return "text-blue-400"
}

function statusDotColor(hasProcess: boolean, agentStatus?: SessionStatus): string {
  const idle = isIdleStatus(agentStatus)
  if (hasProcess) return idle ? "bg-green-500" : "bg-amber-500"
  if (agentStatus && !idle) return "bg-amber-500/60"
  return "bg-muted-foreground"
}

function StatusDot({ hasProcess, agentStatus }: { hasProcess: boolean; agentStatus?: SessionStatus }) {
  const isActive = hasProcess && !isIdleStatus(agentStatus)

  return (
    <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
      {isActive && <span className="absolute inline-flex h-2.5 w-2.5 animate-ping rounded-full bg-amber-400 opacity-75" />}
      <span className={cn("relative inline-flex h-2 w-2 rounded-full", statusDotColor(hasProcess, agentStatus))} />
    </span>
  )
}
