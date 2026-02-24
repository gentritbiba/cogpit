import { useEffect, useRef } from "react"

interface UseNotificationsOptions {
  /** Current isLive state from useLiveSession */
  isLive: boolean
  /** Current session slug or ID for notification title */
  sessionLabel: string | null
  /** Background agents from useBackgroundAgents polling */
  backgroundAgents: Array<{ agentId: string; isActive: boolean; preview: string }> | null
  /** Pending permission/interaction prompt */
  pendingInteraction: { type: string; toolName?: string } | null
  /** Whether sound is enabled (from config) */
  soundEnabled: boolean
}

function playNotificationSound() {
  try {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.frequency.value = 800
    osc.type = "sine"
    gain.gain.value = 0.3
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3)
    osc.start()
    osc.stop(ctx.currentTime + 0.3)
  } catch {
    // AudioContext not available
  }
}

export function useNotifications({
  isLive,
  sessionLabel,
  backgroundAgents,
  pendingInteraction,
  soundEnabled,
}: UseNotificationsOptions) {
  const prevIsLiveRef = useRef<boolean | null>(null)
  const prevAgentsRef = useRef<Map<string, boolean>>(new Map())
  const prevPendingRef = useRef<boolean>(false)

  // Request notification permission on mount
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {})
    }
  }, [])

  // Helper to fire notification + optional sound
  function notify(title: string, body: string) {
    if (!("Notification" in window)) return
    if (Notification.permission !== "granted") return

    new Notification(title, { body })

    if (soundEnabled) {
      playNotificationSound()
    }
  }

  // Watch isLive: true → false = session went idle
  useEffect(() => {
    if (prevIsLiveRef.current === true && !isLive) {
      notify(
        "Session idle",
        sessionLabel ? `"${sessionLabel}" has stopped` : "Session has stopped"
      )
    }
    prevIsLiveRef.current = isLive
  }, [isLive, sessionLabel, soundEnabled])

  // Watch background agents: isActive true → false
  useEffect(() => {
    if (!backgroundAgents) return

    const currentMap = new Map(backgroundAgents.map((a) => [a.agentId, a.isActive]))

    for (const [agentId, wasActive] of prevAgentsRef.current) {
      const isNowActive = currentMap.get(agentId)
      if (wasActive && isNowActive === false) {
        const agent = backgroundAgents.find((a) => a.agentId === agentId)
        const preview = agent?.preview?.slice(0, 60) || agentId.slice(0, 8)
        notify("Agent finished", preview)
      }
    }

    prevAgentsRef.current = currentMap
  }, [backgroundAgents, soundEnabled])

  // Watch pending interaction (permission prompts)
  useEffect(() => {
    const hasPending = !!pendingInteraction
    if (hasPending && !prevPendingRef.current) {
      const toolName = pendingInteraction?.toolName || "Action"
      notify("Permission required", `${toolName} needs your approval`)
    }
    prevPendingRef.current = hasPending
  }, [pendingInteraction, soundEnabled])
}
