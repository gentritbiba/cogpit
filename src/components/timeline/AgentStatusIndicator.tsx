import { memo, useMemo, useState, useEffect, useRef, useCallback } from "react"
import { cn } from "@/lib/utils"
import { deriveSessionStatus, getStatusLabel } from "@/lib/sessionStatus"
import { useSessionContext } from "@/contexts/SessionContext"
import type { SessionStatus } from "@/lib/sessionStatus"

// ── Animated SVG icons ──────────────────────────────────────────────────────

function ThinkingIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" className="size-5">
      <path
        d="M10 2C11.5 6.5 14.5 8.5 18 10C14.5 11.5 11.5 13.5 10 18C8.5 13.5 5.5 11.5 2 10C5.5 8.5 8.5 6.5 10 2Z"
        fill="#F59E0B"
      >
        <animateTransform
          attributeName="transform"
          type="scale"
          values="0.85;1.1;0.85"
          dur="1.5s"
          repeatCount="indefinite"
        />
        <animate
          attributeName="opacity"
          values="0.6;1;0.6"
          dur="1.5s"
          repeatCount="indefinite"
        />
      </path>
    </svg>
  )
}

function ToolUseIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" className="size-5">
      <path
        fill="#60A5FA"
        fillRule="evenodd"
        d="M10 2a.75.75 0 01.75.75v1.59c.943.258 1.798.697 2.535 1.275l1.254-.724a.75.75 0 011.026.24l1 1.732a.75.75 0 01-.24 1.026l-1.254.724a7.025 7.025 0 010 2.574l1.254.724a.75.75 0 01.24 1.026l-1 1.732a.75.75 0 01-1.026-.24l-1.254-.724a8.536 8.536 0 01-2.535 1.275v1.59a.75.75 0 01-.75.75h-2a.75.75 0 01-.75-.75v-1.59a8.536 8.536 0 01-2.535-1.275l-1.254.724a.75.75 0 01-1.026-.24l-1-1.732a.75.75 0 01.24-1.026l1.254-.724a7.025 7.025 0 010-2.574l-1.254-.724a.75.75 0 01-.24-1.026l1-1.732a.75.75 0 011.026-.24l1.254.724c.737-.578 1.592-1.017 2.535-1.275V2.75A.75.75 0 019 2h2zM10 7a3 3 0 100 6 3 3 0 000-6z"
      >
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 10 10"
          to="360 10 10"
          dur="3s"
          repeatCount="indefinite"
        />
      </path>
    </svg>
  )
}

const PROCESSING_OFFSETS = ["0s", "-0.5s", "-1s"]

function ProcessingIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" className="size-5">
      {PROCESSING_OFFSETS.map((begin) => (
        <circle key={begin} cx="10" cy="3" r="1.8" fill="#F59E0B">
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 10 10"
            to="360 10 10"
            dur="1.5s"
            begin={begin}
            repeatCount="indefinite"
          />
          <animate
            attributeName="opacity"
            values="1;0.5;1"
            dur="1.5s"
            begin={begin}
            repeatCount="indefinite"
          />
        </circle>
      ))}
    </svg>
  )
}

function CompletedIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="none"
      stroke="#4ADE80"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-5"
    >
      <path
        d="M4 10l4 4 8-8"
        strokeDasharray="20"
        strokeDashoffset="20"
      >
        <animate
          attributeName="stroke-dashoffset"
          from="20"
          to="0"
          dur="0.5s"
          fill="freeze"
          calcMode="spline"
          keyTimes="0;1"
          keySplines="0.25 0.1 0.25 1"
        />
      </path>
    </svg>
  )
}

function StatusIcon({ status }: { status: SessionStatus }) {
  switch (status) {
    case "thinking":
      return <ThinkingIcon />
    case "tool_use":
      return <ToolUseIcon />
    case "processing":
      return <ProcessingIcon />
    case "completed":
      return <CompletedIcon />
    default:
      return null
  }
}

// ── Main component ──────────────────────────────────────────────────────────

const FADE_DELAY = 2000 // ms to show "Done" before fading
const FADE_DURATION = 600 // ms for the fade-out transition

export const AgentStatusIndicator = memo(function AgentStatusIndicator() {
  const { session, isLive, sseState } = useSessionContext()

  // Show indicator when SSE is connected AND either:
  // - session is actively streaming (isLive), OR
  // - derived status is an active state (tool_use/processing/thinking)
  //   which handles long-running Agent calls where the 30s stale timer
  //   sets isLive=false even though the session is still working.
  const agentStatus = useMemo(() => {
    if (!session || sseState !== "connected") return null
    const status = deriveSessionStatus(
      session.rawMessages as Array<{ type: string; [key: string]: unknown }>
    )
    if (!isLive && (status.status === "completed" || status.status === "idle")) return null
    return status
  }, [session, isLive, sseState])

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

  if (!agentStatus || agentStatus.status === "idle" || fadePhase === "hidden") return null

  const label = getStatusLabel(agentStatus.status, agentStatus.toolName)
  if (!label) return null

  return (
    <div
      className={cn(
        "flex items-center gap-2.5 py-3 px-4 transition-opacity",
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
      {(agentStatus.pendingQueue ?? 0) > 0 && (
        <span className="text-[10px] text-muted-foreground/60 ml-1">
          +{agentStatus.pendingQueue} queued
        </span>
      )}
    </div>
  )
})
