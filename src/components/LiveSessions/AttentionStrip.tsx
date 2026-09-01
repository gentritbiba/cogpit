import { useEffect, useState } from "react"
import { ChevronDown, Play, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { formatRelativeTime, dirNameToPath } from "@/lib/format"
import { getStatusLabel } from "@/lib/sessionStatus"
import { agentKindFromDirName } from "@/lib/sessionSource"
import { isExternalCopilotSession } from "@/lib/sessionControl"
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
    <span data-relative-time className="shrink-0 text-xs tabular-nums text-muted-foreground">
      {formatRelativeTime(iso)}
    </span>
  )
}

const REASON_CHIP: Record<AttentionItem["reason"], { label: string; className: string }> = {
  permission: { label: "Permission", className: "border-warning/30 bg-warning/10 text-warning" },
  deferred: { label: "Deferred", className: "border-warning/30 bg-warning/10 text-warning" },
  question: { label: "Question", className: "border-warning/30 bg-warning/10 text-warning" },
  prompt: { label: "Input needed", className: "border-warning/30 bg-warning/10 text-warning" },
  plan: { label: "Review plan", className: "border-warning/30 bg-warning/10 text-warning" },
  waiting: { label: "Waiting", className: "border-warning/30 bg-warning/10 text-warning" },
  done: { label: "Done", className: "border-success/30 bg-success/10 text-success" },
}

/** Row dot per reason. Anything blocked on a human shares the attention dot. */
const REASON_DOT: Record<AttentionItem["reason"], string> = {
  permission: STATUS_DOT.attention,
  deferred: STATUS_DOT.attention,
  waiting: STATUS_DOT.attention,
  question: "bg-warning",
  prompt: "bg-warning",
  plan: "bg-warning",
  done: "bg-success",
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
  const isExternalCopilot = isExternalCopilotSession(agentKindFromDirName(s.dirName), proc)
  const statusLabel = isExternalCopilot
    ? "Read-only"
    : getStatusLabel(s.agentStatus, s.agentToolName, s.agentTerminalReason, s.agentPendingAgents) ?? chip.label
  const canResume = Boolean(onResume) && !isExternalCopilot
  const { onHoverStart, onHoverEnd } = useHoverPrefetch(onPrefetch)
  return (
    <div
      className={cn(
        "group relative w-full rounded-md text-left transition-colors",
        compact ? "px-2.5 py-2" : "border px-2 py-2",
        cardClassName,
        isActiveSession && !compact && "ring-1 ring-ring",
      )}
    >
      {compact && isActiveSession && (
        <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-primary" aria-hidden="true" />
      )}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              data-attention-session
              onClick={onSelect}
              onMouseEnter={onHoverStart}
              onMouseLeave={onHoverEnd}
              onFocus={onHoverStart}
              onBlur={onHoverEnd}
              className={cn(
                "w-full rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                canResume && "pr-20",
              )}
            />
          }
        >
          <span className="flex items-center gap-1.5">
            <span className={cn("size-1.5 shrink-0 rounded-full", dotClassName, compact && "ring-0")} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-xs leading-tight text-foreground">
              {sessionTitle(s, customName)}
            </span>
            <Badge
              variant="outline"
              className={cn("shrink-0", compact ? "text-muted-foreground" : chip.className)}
            >
              {isExternalCopilot ? "Read-only" : chip.label}
            </Badge>
            {!compact && <TimeSince iso={s.lastActivityAt || s.lastModified} />}
          </span>
          <span className="mt-1 block truncate pl-3 text-xs text-muted-foreground">{projectLabel}</span>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-[280px]">
          <SessionPreview session={s} proc={proc} statusLabel={statusLabel} customName={customName} />
        </TooltipContent>
      </Tooltip>

      {canResume && (
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={onResume}
          className="absolute bottom-1 right-1 text-warning"
          aria-label="Resume to evaluate"
        >
          <Play data-icon="inline-start" />
          Resume
        </Button>
      )}
      {proc && onKill && !isExternalCopilot && (
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
      <span className={cn("text-xs font-medium", labelClassName)}>{label}</span>
      <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
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
  onResumeSession?: (sessionId: string, cwd: string | undefined, dirName: string) => void
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
            labelClassName="text-warning"
            label="Needs you"
            count={groups.needsYou.length}
          />
          {groups.needsYou.map(({ session: s, reason }) => (
            <StripRow
              key={`${s.dirName}/${s.fileName}`}
              {...rowShared(s)}
              chip={REASON_CHIP[reason]}
              dotClassName={REASON_DOT[reason]}
              cardClassName="border-warning/20 bg-warning/5 hover:bg-warning/10"
              onKill={onKill}
              onResume={
                reason === "deferred" && onResumeSession
                  ? () => onResumeSession(s.sessionId, s.cwd, s.dirName)
                  : undefined
              }
            />
          ))}
        </div>
      )}

      {groups.working.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between px-1">
            <span className="text-xs font-medium text-muted-foreground">Working</span>
            <span className="text-xs tabular-nums text-muted-foreground">{groups.working.length}</span>
          </div>
          <div
            data-working-list
            className="flex flex-col gap-0.5 overflow-hidden rounded-lg border bg-background p-0.5"
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
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => setShowAllWorking(true)}
              className="justify-start"
            >
              <ChevronDown data-icon="inline-start" />
              Show {hiddenWorking} more
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
