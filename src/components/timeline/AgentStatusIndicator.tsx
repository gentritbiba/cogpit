import { memo, useMemo, useState, useEffect } from "react"
import { Brain, CheckCircle2, CircleEllipsis, ChevronsDownUp, TerminalSquare } from "lucide-react"
import { cn } from "@/lib/utils"
import { deriveSessionStatus, getStatusLabel } from "@/lib/sessionStatus"
import { formatDuration, getTurnDuration } from "@/lib/format"
import { useSessionContext } from "@/contexts/SessionContext"
import type { SessionStatus, SessionStatusInfo } from "@/lib/sessionStatus"

function StatusIcon({ status }: { status: SessionStatus }) {
  switch (status) {
    case "thinking":
      return <Brain className="size-5 text-amber-500" />
    case "tool_use":
      return <TerminalSquare className="size-5 text-blue-400" />
    case "processing":
      return <CircleEllipsis className="size-5 text-amber-500" />
    case "compacting":
      return <ChevronsDownUp className="size-5 text-amber-500" />
    case "completed":
      return <CheckCircle2 className="size-5 text-emerald-400" />
    default:
      return null
  }
}

// ── Main component ──────────────────────────────────────────────────────────

const FADE_DELAY = 2000 // ms to show "Done" before fading
const FADE_DURATION = 600 // ms for the fade-out transition

function AgentStatusLine({
  status,
  label,
  fading = false,
  startTimestamp,
}: {
  status: SessionStatusInfo
  label: string
  fading?: boolean
  startTimestamp?: string
}) {
  const isCompleted = status.status === "completed"

  return (
    <div
      className={cn(
        "flex items-center gap-2.5 transition-opacity",
        fading ? "opacity-0" : "opacity-100",
      )}
      style={{ transitionDuration: `${FADE_DURATION}ms` }}
    >
      <StatusIcon status={status.status} />
      <span
        className={cn(
          "text-xs font-medium",
          !isCompleted && "text-muted-foreground",
          isCompleted && status.terminalReason && "text-amber-400",
          isCompleted && !status.terminalReason && "text-green-400",
        )}
      >
        {label}
      </span>
      {!isCompleted && startTimestamp && (
        <LiveElapsed startTimestamp={startTimestamp} />
      )}
      {(status.pendingQueue ?? 0) > 0 && (
        <span className="text-[10px] text-muted-foreground/60 ml-1">
          +{status.pendingQueue} queued
        </span>
      )}
    </div>
  )
}

function CompletedAgentStatus({
  status,
  durationLabel,
}: {
  status: SessionStatusInfo
  durationLabel: string | null
}) {
  const [fadePhase, setFadePhase] = useState<"visible" | "fading" | "hidden">("visible")

  useEffect(() => {
    const fadeTimer = setTimeout(() => setFadePhase("fading"), FADE_DELAY)
    const hideTimer = setTimeout(
      () => setFadePhase("hidden"),
      FADE_DELAY + FADE_DURATION,
    )
    return () => {
      clearTimeout(fadeTimer)
      clearTimeout(hideTimer)
    }
  }, [])

  const label = getStatusLabel(status.status, status.toolName, status.terminalReason) ?? "Done"
  const showStatus = fadePhase !== "hidden"
  if (!showStatus && !durationLabel) return null

  return (
    <div className="flex items-center gap-2.5 py-3 px-4">
      {showStatus && (
        <AgentStatusLine
          status={status}
          label={label}
          fading={fadePhase === "fading"}
        />
      )}
      {durationLabel && (
        <span className="text-[10px] text-muted-foreground/50 font-mono tabular-nums">
          {showStatus ? "in " : ""}{durationLabel}
        </span>
      )}
    </div>
  )
}

export const AgentStatusIndicator = memo(function AgentStatusIndicator() {
  const { session, isLive, sseState, isCompacting } = useSessionContext()

  // Suppress stale "completed" when isLive transitions false→true (new turn starting).
  // Without this, the old "Done" briefly flashes before the new user message arrives.
  const [suppressCompleted, setSuppressCompleted] = useState(false)

  const derivedStatus = useMemo(() => {
    if (!session || sseState !== "connected") return null

    // In-progress compaction detected via subagent file watcher
    if (isCompacting) return { status: "compacting" as const }

    return deriveSessionStatus(
      session.rawMessages as Array<{ type: string; [key: string]: unknown }>
    )
  }, [session, sseState, isCompacting])

  // Advance the stale-completion state only after React commits the status that
  // caused it. This keeps speculative renders from mutating future UI state.
  useEffect(() => {
    if (!derivedStatus || derivedStatus.status === "compacting" || derivedStatus.status === "idle") return

    if (!isLive) {
      if (derivedStatus.status === "completed") setSuppressCompleted(true)
      return
    }

    // A non-completed status means a new turn has genuinely started.
    if (derivedStatus.status !== "completed") setSuppressCompleted(false)
  }, [derivedStatus, isLive])

  const agentStatus = useMemo(() => {
    if (!derivedStatus) return null

    // Compaction remains visible even while ordinary live output is paused.
    if (derivedStatus.status === "compacting") return derivedStatus
    if (!isLive || derivedStatus.status === "idle") return null

    // Suppress a completed status carried over from the previous turn.
    if (derivedStatus.status === "completed" && suppressCompleted) return null
    return derivedStatus
  }, [derivedStatus, isLive, suppressCompleted])

  const isCompleted = agentStatus?.status === "completed"
  const lastTurn = session?.turns[session.turns.length - 1] ?? null

  // Compute turn duration for "Done" display
  // NOTE: This useMemo must be called before early returns to satisfy Rules of Hooks.
  const durationLabel = useMemo(() => {
    if (!isCompleted || !lastTurn) return null
    const ms = getTurnDuration(lastTurn)
    return ms !== null ? formatDuration(ms) : null
  }, [isCompleted, lastTurn])

  if (!agentStatus) return null

  if (isCompleted) {
    return <CompletedAgentStatus status={agentStatus} durationLabel={durationLabel} />
  }

  const label = getStatusLabel(agentStatus.status, agentStatus.toolName, agentStatus.terminalReason)
  if (!label) return null

  return (
    <div className="flex items-center gap-2.5 py-3 px-4">
      <AgentStatusLine
        status={agentStatus}
        label={label}
        startTimestamp={lastTurn?.timestamp}
      />
    </div>
  )
})

// ── Live elapsed timer ──────────────────────────────────────────────────────

export function LiveElapsed({ startTimestamp, className }: { startTimestamp: string; className?: string }) {
  return (
    <LiveElapsedTimer
      key={startTimestamp}
      startTimestamp={startTimestamp}
      className={className}
    />
  )
}

function LiveElapsedTimer({ startTimestamp, className }: { startTimestamp: string; className?: string }) {
  const startMs = new Date(startTimestamp).getTime()
  const [elapsed, setElapsed] = useState(() => Date.now() - startMs)

  useEffect(() => {
    const id = setInterval(() => setElapsed(Date.now() - startMs), 1000)
    return () => clearInterval(id)
  }, [startMs])

  return (
    <span className={cn("text-[10px] text-muted-foreground/40 tabular-nums font-mono", className)}>
      {formatDuration(Math.max(0, elapsed))}
    </span>
  )
}
