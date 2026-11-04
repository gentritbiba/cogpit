import { useCallback, useEffect, useRef, useState } from "react"
import { authFetch } from "@/lib/auth"
import type { AgentCheck, AgentCheckResponse } from "../../shared/contracts/agentCheck"

export interface AgentCheckState {
  /** Null until the first check answers. */
  agents: AgentCheck[] | null
  checking: boolean
  error: string | null
  /** Probe every agent again, for after the person installed or signed in to one. */
  recheck: () => void
}

/** The agent check, run on mount and again on {@link AgentCheckState.recheck}. */
export function useAgentCheck(enabled = true): AgentCheckState {
  const [agents, setAgents] = useState<AgentCheck[] | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [runKey, setRunKey] = useState(0)
  const runRef = useRef(0)

  useEffect(() => {
    if (!enabled) return
    const run = ++runRef.current
    const controller = new AbortController()
    setChecking(true)
    setError(null)
    authFetch("/api/agent-check", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Agent check failed (${res.status})`)
        return (await res.json()) as AgentCheckResponse
      })
      .then((data) => {
        if (run === runRef.current) setAgents(data.agents)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || run !== runRef.current) return
        setError(err instanceof Error ? err.message : "Agent check failed")
      })
      .finally(() => {
        if (run === runRef.current) setChecking(false)
      })
    return () => controller.abort()
  }, [enabled, runKey])

  const recheck = useCallback(() => setRunKey((key) => key + 1), [])

  return { agents, checking, error, recheck }
}
