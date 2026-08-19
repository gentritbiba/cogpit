import { useEffect, useState } from "react"
import { ChevronDown, Play, X } from "lucide-react"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { formatRelativeTime, dirNameToPath } from "@/lib/format"
import { getStatusLabel } from "@/lib/sessionStatus"
import type { ActiveSessionInfo, RunningProcess } from "./types"
import type { AttentionGroups, AttentionItem } from "./attentionGroups"
import { workingChip } from "./attentionGroups"
import { sessionTitle, projectGroupKey } from "./sessionListView"
import { SessionPreview } from "./SessionPreview"
import { STATUS_DOT } from "./statusDot"
import { useHoverPrefetch } from "./useHoverPrefetch"

/** Working rows shown before the "+N more" expander. */
const WORKING_VISIBLE = 6

/** Relative time that re-renders every 15s so strip rows stay honest. */
function TimeSince({ iso }: { iso: string }) {
  const [, forceTick] = useState(0)
  useEffect(() => {
    const interval = setInterval(() => forceTick((n) => n + 1), 15_000)
    return () => clearInterval(interval)
  }, [])
  return (
    <span data-relative-time className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
      {formatRelativeTime(iso)}
    </span>
  )
}

const REASON_CHIP: Record<AttentionItem["reason"], { label: string; className: string }> = {
  permission: { label: "Permission", className: "bg-amber-500/15 text-amber-400" },
  deferred: { label: "Deferred", className: "bg-amber-500/15 text-amber-400" },
  // Pink is the app's established colour for AskUserQuestion (tool badge,
  // composer bar, timeline form), so a blocked question reads the same
  // everywhere.
  question: { label: "Question", className: "bg-pink-500/15 text-pink-400" },
  waiting: { label: "Waiting", className: "bg-amber-500/10 text-amber-300/90" },
  done: { label: "Done", className: "bg-green-500/10 text-green-400" },
}

/** Row dot per reason. Anything blocked on a human shares the attention dot. */
const REASON_DOT: Record<AttentionItem["reason"], string> = {
  permission: STATUS_DOT.attention,
  deferred: STATUS_DOT.attention,
  waiting: STATUS_DOT.attention,
  question: "bg-pink-400",
  done: "bg-green-400",
}

interface StripRowProps {
  session: ActiveSessionInfo
  chip: { label: string; className: string }
  dotClassName: string
  cardClassName: string
  isActiveSession: boolean
  proc?: RunningProcess
  killingPids: Set<number>
  customName?: string
  projectLabel: string
  compact?: boolean
  onSelect: () => void
  onKill?: (pid: number, e: React.MouseEvent) => void
  onResume?: () => void
  onPrefetch?: () => void
}

function StripRow({
  session: s,
  chip,
  dotClassName,
  cardClassName,
  isActiveSession,
  proc,
  killingPids,
  customName,
  projectLabel,
  compact = false,
  onSelect,
  onKill,
  onResume,
  onPrefetch,
}: StripRowProps) {
  const statusLabel = getStatusLabel(s.agentStatus, s.agentToolName, s.agentTerminalReason, s.agentPendingAgents) ?? chip.label
  const { onHoverStart, onHoverEnd } = useHoverPrefetch(onPrefetch)
  return (
    <Tooltip>
      <TooltipTrigger render={<div
          role="button"
          tabIndex={0}
          data-attention-session
          onClick={onSelect}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault()
              onSelect()
            }
          }}
          onMouseEnter={onHoverStart}
          onMouseLeave={onHoverEnd}
          onFocus={onHoverStart}
          onBlur={onHoverEnd}
          className={cn(
            "group relative w-full cursor-pointer rounded-md text-left transition-colors duration-100",
            compact ? "border-0 px-2.5 py-2" : "border px-2 py-1.5",
            cardClassName,
            isActiveSession && !compact && "border-l-2 border-l-blue-500",
          )}
        />}>
        {compact && isActiveSession && (
          <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-primary" aria-hidden="true" />
        )}
        <div className="flex items-center gap-1.5">
          <span className={cn("size-1.5 shrink-0 rounded-full", dotClassName, compact && "ring-0")} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-xs leading-tight text-foreground">
            {sessionTitle(s, customName)}
          </span>
          <span className={cn(
            "shrink-0 font-medium",
            compact ? "text-[10px] text-muted-foreground" : "rounded px-1 py-px text-[9px]",
            chip.className,
          )}>
            {chip.label}
          </span>
          {!compact && <TimeSince iso={s.lastActivityAt || s.lastModified} />}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 pl-3">
          <span className="truncate text-[10px] text-muted-foreground/60">{projectLabel}</span>
          {onResume && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onResume() }}
              className="flex shrink-0 items-center gap-0.5 rounded bg-amber-500/15 px-1 py-px text-[9px] font-medium text-amber-400 transition-colors hover:bg-amber-500/25 hover:text-amber-300"
              aria-label="Resume to evaluate"
            >
              <Play className="size-2 fill-current" />
              Resume
            </button>
          )}
        </div>
        {proc && onKill && (
          <button
            type="button"
            onClick={(e) => onKill(proc.pid, e)}
            disabled={killingPids.has(proc.pid)}
            className="absolute right-0 top-0 z-10 rounded-bl rounded-tr-md p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-red-500/20 hover:text-red-400 focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 disabled:opacity-50"
            title={`Kill PID ${proc.pid}`}
            aria-label={`Kill process ${proc.pid}`}
          >
            <X className="size-2.5" />
          </button>
        )}
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-[280px]">
        <SessionPreview session={s} proc={proc} statusLabel={statusLabel} customName={customName} />
      </TooltipContent>
    </Tooltip>
  )
}

function SectionHeader({ dotClassName, labelClassName, label, count }: {
  dotClassName: string
  labelClassName: string
  label: string
  count: number
}) {
  return (
    <div className="flex items-center gap-1.5 px-0.5">
      <span className={cn("size-1.5 rounded-full", dotClassName)} aria-hidden="true" />
      <span className={cn("text-[10px] font-semibold tracking-wider", labelClassName)}>{label}</span>
      <span className="text-[10px] text-muted-foreground/50">{count}</span>
    </div>
  )
}

interface AttentionStripProps {
  groups: AttentionGroups
  activeSessionKey: string | null
  procBySession: Map<string, RunningProcess>
  killingPids: Set<number>
  sessionNames: Record<string, string>
  projectNames: Record<string, string>
  onSelectSession: (dirName: string, fileName: string) => void
  onKill?: (pid: number, e: React.MouseEvent) => void
  onResumeSession?: (sessionId: string, cwd?: string) => void
  onPrefetchSession?: (dirName: string, fileName: string) => void
}

/**
 * Cross-project triage at the top of the sidebar: sessions that are blocked
 * on the user ("Needs you") and agents currently running ("Working"). The
 * project tree below stays the browsing surface; this answers "where should
 * I look right now?" at a glance.
 */
export function AttentionStrip({
  groups,
  activeSessionKey,
  procBySession,
  killingPids,
  sessionNames,
  projectNames,
  onSelectSession,
  onKill,
  onResumeSession,
  onPrefetchSession,
}: AttentionStripProps) {
  const [showAllWorking, setShowAllWorking] = useState(false)
  const visibleWorking = showAllWorking ? groups.working : groups.working.slice(0, WORKING_VISIBLE)
  const hiddenWorking = groups.working.length - visibleWorking.length

  const projectLabel = (s: ActiveSessionInfo) =>
    projectNames[s.dirName] || projectGroupKey(s.cwd || dirNameToPath(s.dirName))

  const rowShared = (s: ActiveSessionInfo) => {
    const isActiveSession = activeSessionKey === `${s.dirName}/${s.fileName}`
    return {
      session: s,
      isActiveSession,
      proc: procBySession.get(s.sessionId),
      killingPids,
      customName: sessionNames[s.sessionId],
      projectLabel: projectLabel(s),
      onSelect: () => onSelectSession(s.dirName, s.fileName),
      onPrefetch: onPrefetchSession && !isActiveSession
        ? () => onPrefetchSession(s.dirName, s.fileName)
        : undefined,
    }
  }

  return (
    <div className="flex flex-col gap-2" data-attention-strip>
      {groups.needsYou.length > 0 && (
        <div className="flex flex-col gap-1">
          <SectionHeader
            dotClassName={STATUS_DOT.attention}
            labelClassName="text-amber-400/90"
            label="NEEDS YOU"
            count={groups.needsYou.length}
          />
          {groups.needsYou.map(({ session: s, reason }) => (
            <StripRow
              key={`${s.dirName}/${s.fileName}`}
              {...rowShared(s)}
              chip={REASON_CHIP[reason]}
              dotClassName={REASON_DOT[reason]}
              cardClassName="border-amber-500/20 bg-amber-500/[0.04] hover:bg-amber-500/[0.08]"
              onKill={onKill}
              onResume={
                reason === "deferred" && onResumeSession
                  ? () => onResumeSession(s.sessionId, s.cwd)
                  : undefined
              }
            />
          ))}
        </div>
      )}

      {groups.working.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between px-1">
            <span className="text-[11px] font-medium text-muted-foreground">Working</span>
            <span className="text-[10px] tabular-nums text-muted-foreground/60">{groups.working.length}</span>
          </div>
          <div
            data-working-list
            className="flex flex-col gap-0.5 overflow-hidden rounded-lg border border-border/50 bg-muted/20 p-0.5"
          >
            {visibleWorking.map((s) => (
              <StripRow
                key={`${s.dirName}/${s.fileName}`}
                {...rowShared(s)}
                chip={{ label: workingChip(s), className: "" }}
                dotClassName={STATUS_DOT.working}
                cardClassName="hover:bg-accent/50"
                compact
                onKill={onKill}
              />
            ))}
          </div>
          {hiddenWorking > 0 && (
            <button
              type="button"
              onClick={() => setShowAllWorking(true)}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-left text-[11px] text-muted-foreground/60 transition-colors hover:bg-white/[0.03] hover:text-foreground"
            >
              <ChevronDown className="size-2.5" />
              Show {hiddenWorking} more
            </button>
          )}
        </div>
      )}
    </div>
  )
}
