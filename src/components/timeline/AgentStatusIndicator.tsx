import { memo, useMemo, useRef, useState, useEffect } from "react"
import { Bot, Brain, CheckCircle2, ChevronDown, CircleDashed, CircleEllipsis, ChevronsDownUp, CircleHelp, TerminalSquare } from "lucide-react"
import { cn } from "@/lib/utils"
import { getStatusLabel, getTerminalReasonLabel } from "../../../shared/session/sessionStatus"
import { formatDuration, getTurnDuration } from "@/lib/format"
import { useSessionContext } from "@/contexts/SessionContext"
import { useAgentProgress } from "@/contexts/StreamingOverlayContext"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import type { SessionStatus, SessionStatusInfo } from "../../../shared/session/sessionStatus"
import type { BackgroundAgent } from "../../../shared/session/types"
import { AgentFailureNotice } from "@/components/AgentSetupHelp"
import { agentKindForDirName } from "@/lib/agents"
import { signInTargetFor } from "@/lib/agents/signIn"

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
      {(status.pendingQueue ?? 0) > 0 && (
        <span className="ml-1 shrink-0 text-xs text-muted-foreground">
          +{status.pendingQueue} queued
        </span>
      )}
    </div>
  )
}

/**
 * The turn ended and the session is waiting on background agents: one row per
 * agent in the current batch, with how far along the batch is.
 *
 * Running rows are deliberately static — this card can sit off-screen for the
 * whole wait, and the ticking timers already show the agents are alive.
 */
function AwaitingAgentsStatus({
  status,
  startTimestamp,
}: {
  status: SessionStatusInfo
  startTimestamp?: string
}) {
  const [open, setOpen] = useState(true)
  const agents = status.backgroundAgents ?? []
  const running = agents.filter((agent) => !agent.done).length
  // Each finished agent wakes the parent for a short turn, so the turn start
  // would restart the clock; the batch's first launch is when the wait began.
  const waitingSince = agents.find((agent) => agent.startedAt)?.startedAt ?? startTimestamp

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="mx-4 my-3 rounded-lg border border-border/60 bg-muted/20"
      data-testid="awaiting-agents"
    >
      <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left">
        <Bot className="size-4 shrink-0 text-info" />
        <span className="truncate text-xs font-medium text-foreground">
          {running < agents.length
            ? `Waiting on ${running} of ${agents.length} agents`
            : `Waiting on ${running} agent${running === 1 ? "" : "s"}`}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {(status.pendingQueue ?? 0) > 0 && (
            <span className="text-xs text-muted-foreground">+{status.pendingQueue} queued</span>
          )}
          {waitingSince && <LiveElapsed startTimestamp={waitingSince} />}
          <ChevronDown
            className={cn("size-3.5 text-muted-foreground transition-transform", !open && "-rotate-90")}
          />
        </span>
      </CollapsibleTrigger>
      {agents.length > 1 && <BatchProgress agents={agents} />}
      <CollapsibleContent>
        <ul className="flex flex-col border-t border-border/40 py-1">
          {agents.map((agent, index) => (
            <BackgroundAgentRow key={agent.toolUseId ?? index} agent={agent} />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

function BatchProgress({ agents }: { agents: BackgroundAgent[] }) {
  return (
    <div className="px-3 pb-2.5" aria-hidden>
      <div className="flex h-1 gap-0.5">
        {agents.map((agent, index) => (
          <span key={index} className={cn("flex-1 rounded-full", agent.done ? "bg-success" : "bg-info/25")} />
        ))}
      </div>
    </div>
  )
}

function BackgroundAgentRow({ agent }: { agent: BackgroundAgent }) {
  const summary = useAgentProgress(agent.done ? undefined : agent.toolUseId)

  return (
    <li className="flex min-w-0 items-start gap-2.5 px-3 py-1.5" data-agent-done={agent.done || undefined}>
      {agent.done
        ? <CheckCircle2 className="mt-px size-3.5 shrink-0 text-success" />
        : <CircleDashed className="mt-px size-3.5 shrink-0 text-info" />}
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn("truncate text-xs", agent.done ? "text-muted-foreground" : "text-foreground")}
          title={agent.description || undefined}
        >
          {agent.description || "Agent"}
        </span>
        {summary && <span className="truncate text-xs text-muted-foreground" title={summary}>{summary}</span>}
      </span>
      {agent.done
        ? <span className="shrink-0 text-xs text-muted-foreground">Done</span>
        : agent.startedAt && <LiveElapsed startTimestamp={agent.startedAt} className="shrink-0" />}
    </li>
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
  const { session, sessionSource, isLive, sseState, isCompacting, pendingInteraction } = useSessionContext()

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

    // In-progress compaction announced by the runtime over the watch stream
    if (isCompacting) return { status: "compacting" as const }

    return session.digest.status
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
  // A turn that failed stays failed however long ago it ran, so this is not
  // gated on having watched it end the way the ready line is.
  const failure = derivedStatus?.status === "completed" ? derivedStatus.failure : undefined

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

  if (failure) {
    const dirName = sessionSource?.dirName
    return <AgentFailureNotice target={signInTargetFor(agentKindForDirName(dirName), dirName)} failure={failure} />
  }

  if (!agentStatus) return null

  if (isCompleted) {
    return <CompletedAgentStatus status={agentStatus} durationLabel={durationLabel} />
  }

  if (agentStatus.status === "awaiting_agents") {
    return <AwaitingAgentsStatus status={agentStatus} startTimestamp={lastTurn?.timestamp} />
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
