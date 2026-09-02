import { memo, useMemo, useRef, useState, useEffect } from "react"
import { Bot, Brain, CheckCircle2, CircleEllipsis, ChevronsDownUp, CircleHelp, TerminalSquare } from "lucide-react"
import { cn } from "@/lib/utils"
import { deriveSessionStatus, getStatusLabel, getTerminalReasonLabel } from "../../../shared/session/sessionStatus"
import { formatDuration, getTurnDuration } from "@/lib/format"
import { useSessionContext } from "@/contexts/SessionContext"
import type { SessionStatus, SessionStatusInfo } from "../../../shared/session/sessionStatus"

function StatusIcon({ status }: { status: SessionStatus }) {
  switch (status) {
    case "thinking":
      return <Brain className="size-5 text-warning" />
    case "tool_use":
      return <TerminalSquare className="size-5 text-info" />
    case "processing":
      return <CircleEllipsis className="size-5 text-warning" />
    case "compacting":
      return <ChevronsDownUp className="size-5 text-warning" />
    case "awaiting_agents":
      return <Bot className="size-5 text-info" />
    case "completed":
      return <CheckCircle2 className="size-5 text-success" />
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
  const pendingDescriptions = status.pendingAgentDescriptions ?? []

  return (
    <div
      className={cn(
        "flex items-center gap-2.5 min-w-0 transition-opacity",
        fading ? "opacity-0" : "opacity-100",
      )}
      style={{ transitionDuration: `${FADE_DURATION}ms` }}
    >
      <StatusIcon status={status.status} />
      <span
        className={cn(
          "text-xs font-medium shrink-0",
          !isCompleted && "text-muted-foreground",
          isCompleted && status.terminalReason && "text-warning",
          isCompleted && !status.terminalReason && "text-success",
        )}
      >
        {label}
      </span>
      {!isCompleted && startTimestamp && (
        <LiveElapsed startTimestamp={startTimestamp} />
      )}
      {pendingDescriptions.length > 0 && (
        <span
          className="truncate text-xs text-muted-foreground"
          title={pendingDescriptions.join("\n")}
        >
          {pendingDescriptions.join(" · ")}
        </span>
      )}
      {(status.pendingQueue ?? 0) > 0 && (
        <span className="ml-1 shrink-0 text-xs text-muted-foreground">
          +{status.pendingQueue} queued
        </span>
      )}
    </div>
  )
}

/**
 * "Done" flashes with the turn duration, then settles into a persistent
 * "Waiting for your input" line — the signal that the agent is truly idle
 * (no running turn, no background agents) and the next move is the user's.
 */
function CompletedAgentStatus({
  status,
  durationLabel,
}: {
  status: SessionStatusInfo
  durationLabel: string | null
}) {
  const [fadePhase, setFadePhase] = useState<"visible" | "fading" | "ready">("visible")

  useEffect(() => {
    const fadeTimer = setTimeout(() => setFadePhase("fading"), FADE_DELAY)
    const readyTimer = setTimeout(
      () => setFadePhase("ready"),
      FADE_DELAY + FADE_DURATION,
    )
    return () => {
      clearTimeout(fadeTimer)
      clearTimeout(readyTimer)
    }
  }, [])

  if (fadePhase === "ready") {
    return (
      <div className="flex items-center gap-2.5 py-3 px-4" data-agent-ready>
        <CheckCircle2 className="size-4 shrink-0 text-success" />
        <span className={cn(
          "text-xs font-medium",
          status.terminalReason ? "text-warning" : "text-muted-foreground",
        )}>
          {status.terminalReason ? getTerminalReasonLabel(status.terminalReason) : "Waiting for your input"}
        </span>
        {durationLabel && (
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {durationLabel}
          </span>
        )}
      </div>
    )
  }

  const label = getStatusLabel(status.status, status.toolName, status.terminalReason) ?? "Done"
  return (
    <div className="flex items-center gap-2.5 py-3 px-4">
      <AgentStatusLine
        status={status}
        label={label}
        fading={fadePhase === "fading"}
      />
      {durationLabel && (
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          in {durationLabel}
        </span>
      )}
    </div>
  )
}

export const AgentStatusIndicator = memo(function AgentStatusIndicator() {
  const { session, isLive, sseState, isCompacting, pendingInteraction } = useSessionContext()

  // Suppress stale "completed" when isLive transitions false→true (new turn starting).
  // Without this, the old "Done" briefly flashes before the new user message arrives.
  const [suppressCompleted, setSuppressCompleted] = useState(false)
  // Once a completion was witnessed live, keep showing "Waiting for your input"
  // even after the SSE stale timer flips isLive off — the whole point of the
  // ready indicator is surviving the quiet stretch until the user comes back.
  const [readyLatched, setReadyLatched] = useState(false)

  // The component stays mounted across session switches, so both latches are
  // per-session state that must reset with the session identity — otherwise a
  // ready latch earned in one session leaks a "Waiting for your input" line
  // into every archived session opened after it. Reset during render (not in
  // an effect) so the stale latch never paints a frame.
  const sessionId = session?.sessionId
  const [latchedSessionId, setLatchedSessionId] = useState(sessionId)
  if (sessionId !== latchedSessionId) {
    setLatchedSessionId(sessionId)
    setSuppressCompleted(false)
    setReadyLatched(false)
  }

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
      if (derivedStatus.status === "completed" && !readyLatched) setSuppressCompleted(true)
      return
    }

    if (derivedStatus.status === "completed") {
      setReadyLatched(true)
      return
    }
    // A non-completed status means a new turn has genuinely started.
    setSuppressCompleted(false)
    setReadyLatched(false)
  }, [derivedStatus, isLive, readyLatched])

  const agentStatus = useMemo(() => {
    if (!derivedStatus) return null

    // Compaction remains visible even while ordinary live output is paused.
    if (derivedStatus.status === "compacting") return derivedStatus

    // A completed status witnessed live persists as the ready indicator.
    if (derivedStatus.status === "completed") {
      if (suppressCompleted) return null
      if (!isLive && !readyLatched) return null
      return derivedStatus
    }

    if (!isLive || derivedStatus.status === "idle") return null
    return derivedStatus
  }, [derivedStatus, isLive, suppressCompleted, readyLatched])

  const isCompleted = agentStatus?.status === "completed"
  const lastTurn = session?.turns[session.turns.length - 1] ?? null

  // Compute turn duration for "Done" display
  // NOTE: This useMemo must be called before early returns to satisfy Rules of Hooks.
  const durationLabel = useMemo(() => {
    if (!isCompleted || !lastTurn) return null
    const ms = getTurnDuration(lastTurn)
    return ms !== null ? formatDuration(ms) : null
  }, [isCompleted, lastTurn])

  // An interactive prompt blocks the turn, which means the session emits no
  // traffic: isLive is false and the derived status reads as idle. Surfacing it
  // here is the only signal that the session is waiting rather than finished.
  // sseState gates it: browsing an archived session whose last turn ended in an
  // abandoned question must not show a live "waiting" prompt.
  if (pendingInteraction && sseState === "connected") {
    return (
      <div className="flex items-center gap-2.5 py-3 px-4">
        <CircleHelp className="size-5 shrink-0 text-info" />
        <span className="text-xs font-medium text-info">
          {pendingInteraction.type === "plan"
            ? "Waiting for plan approval"
            : "Waiting for your answer"}
        </span>
      </div>
    )
  }

  if (!agentStatus) return null

  if (isCompleted) {
    return <CompletedAgentStatus status={agentStatus} durationLabel={durationLabel} />
  }

  const label = getStatusLabel(agentStatus.status, agentStatus.toolName, agentStatus.terminalReason, agentStatus.pendingAgents)
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
  const labelRef = useRef<HTMLSpanElement>(null)

  // The clock writes its own text node once a second. Holding the elapsed time
  // in React state would commit a render every second for the whole turn it is
  // attached to, which is exactly when the transcript is streaming and least
  // able to spare it.
  useEffect(() => {
    const paint = () => {
      const el = labelRef.current
      if (el) el.textContent = formatDuration(Math.max(0, Date.now() - startMs))
    }
    const id = setInterval(paint, 1000)
    return () => clearInterval(id)
  }, [startMs])

  return (
    <span
      ref={labelRef}
      className={cn("font-mono text-xs tabular-nums text-muted-foreground", className)}
    >
      {formatDuration(Math.max(0, Date.now() - startMs))}
    </span>
  )
}
