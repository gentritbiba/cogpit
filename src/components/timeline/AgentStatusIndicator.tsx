import { memo, useMemo, useState, useEffect, useRef, useCallback } from "react"
import { cn } from "@/lib/utils"
import { deriveSessionStatus, getStatusLabel } from "@/lib/sessionStatus"
import { formatDuration, getTurnDuration } from "@/lib/format"
import { useSessionContext } from "@/contexts/SessionContext"
import type { SessionStatus } from "@/lib/sessionStatus"
import {
  ThinkingIcon,
  ToolUseIcon,
  ProcessingIcon,
  CompactingIcon,
  CompletedIcon,
} from "@/components/ui/StatusIcons"

function StatusIcon({ status }: { status: SessionStatus }) {
  switch (status) {
    case "thinking":
      return <ThinkingIcon className="text-amber-500" />
    case "tool_use":
      return <ToolUseIcon className="text-blue-400" />
    case "processing":
      return <ProcessingIcon className="text-amber-500" />
    case "compacting":
      return <CompactingIcon className="text-amber-500" />
    case "completed":
      return <CompletedIcon className="text-emerald-400" />
    default:
      return null
  }
}

// ── Main component ──────────────────────────────────────────────────────────

const FADE_DELAY = 2000 // ms to show "Done" before fading
const FADE_DURATION = 600 // ms for the fade-out transition

export const AgentStatusIndicator = memo(function AgentStatusIndicator() {
  const { session, isLive, sseState, isCompacting } = useSessionContext()

  // Suppress stale "completed" when isLive transitions false→true (new turn starting).
  // Without this, the old "Done" briefly flashes before the new user message arrives.
  const suppressCompletedRef = useRef(false)

  const agentStatus = useMemo(() => {
    if (!session || sseState !== "connected") return null

    // In-progress compaction detected via subagent file watcher
    if (isCompacting) return { status: "compacting" as const }

    const status = deriveSessionStatus(
      session.rawMessages as Array<{ type: string; [key: string]: unknown }>
    )

    // Hide everything when not live — server may be stopped/paused
    if (!isLive) {
      if (status.status === "completed") suppressCompletedRef.current = true
      return null
    }

    if (status.status === "idle") return null

    // Suppress stale "completed" carried over from previous turn
    if (status.status === "completed" && suppressCompletedRef.current) return null

    // Non-completed status means a new turn has genuinely started — clear suppress flag
    if (status.status !== "completed") suppressCompletedRef.current = false

    return status
  }, [session, isLive, sseState, isCompacting])

  // Three-phase lifecycle: "visible" → "fading" → "hidden"
  const [fadePhase, setFadePhase] = useState<"visible" | "fading" | "hidden">("visible")
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])

  const clearTimers = useCallback(() => {
    for (const t of timersRef.current) clearTimeout(t)
    timersRef.current = []
  }, [])

  const isCompleted = agentStatus?.status === "completed"

  useEffect(() => {
    clearTimers()
    if (isCompleted) {
      timersRef.current.push(
        setTimeout(() => setFadePhase("fading"), FADE_DELAY),
        setTimeout(() => setFadePhase("hidden"), FADE_DELAY + FADE_DURATION),
      )
    } else {
      setFadePhase("visible")
    }
    return clearTimers
  }, [isCompleted, clearTimers])

  const isActive = !isCompleted
  const lastTurn = session?.turns[session.turns.length - 1] ?? null

  // Compute turn duration for "Done" display
  // NOTE: This useMemo must be called before early returns to satisfy Rules of Hooks.
  const durationLabel = useMemo(() => {
    if (!isCompleted || !lastTurn) return null
    const ms = getTurnDuration(lastTurn)
    return ms !== null ? formatDuration(ms) : null
  }, [isCompleted, lastTurn])

  const showStatus = agentStatus && agentStatus.status !== "idle" && fadePhase !== "hidden"
  const label = showStatus ? getStatusLabel(agentStatus.status, agentStatus.toolName) : null

  // Show duration standalone after status fades, hide only when a new turn starts
  if (!label && !durationLabel) return null

  return (
    <div className="flex items-center gap-2.5 py-3 px-4">
      {label && (
        <div
          className={cn(
            "flex items-center gap-2.5 transition-opacity",
            fadePhase === "fading" ? "opacity-0" : "opacity-100",
          )}
          style={{ transitionDuration: `${FADE_DURATION}ms` }}
        >
          <StatusIcon status={agentStatus.status} />
          <span
            className={cn(
              "text-xs font-medium",
              isCompleted ? "text-green-400" : "text-muted-foreground",
            )}
          >
            {label}
          </span>
          {isActive && lastTurn?.timestamp && (
            <LiveElapsed startTimestamp={lastTurn.timestamp} />
          )}
          {(agentStatus.pendingQueue ?? 0) > 0 && (
            <span className="text-[10px] text-muted-foreground/60 ml-1">
              +{agentStatus.pendingQueue} queued
            </span>
          )}
        </div>
      )}
      {durationLabel && (
        <span className="text-[10px] text-muted-foreground/50 font-mono tabular-nums">
          {label ? "in " : ""}{durationLabel}
        </span>
      )}
    </div>
  )
})

// ── Live elapsed timer ──────────────────────────────────────────────────────

export function LiveElapsed({ startTimestamp, className }: { startTimestamp: string; className?: string }) {
  const startMs = useRef(new Date(startTimestamp).getTime())
  const [elapsed, setElapsed] = useState(() => Date.now() - startMs.current)

  useEffect(() => {
    startMs.current = new Date(startTimestamp).getTime()
    setElapsed(Date.now() - startMs.current)
  }, [startTimestamp])

  useEffect(() => {
    const id = setInterval(() => setElapsed(Date.now() - startMs.current), 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <span className={cn("text-[10px] text-muted-foreground/40 tabular-nums font-mono", className)}>
      {formatDuration(Math.max(0, elapsed))}
    </span>
  )
}
