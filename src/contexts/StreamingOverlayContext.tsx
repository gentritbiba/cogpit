import { createContext, useContext, type ReactNode } from "react"
import { EMPTY_OVERLAY, type StreamingOverlay } from "@/lib/streamingOverlay"

const EMPTY_AGENT_PROGRESS: Record<string, string> = {}

/**
 * Dedicated context for the token-streaming overlay.
 *
 * Deliberately separate from SessionContext: the overlay updates at up to
 * ~13 Hz while a turn streams, and putting it on the session context would
 * re-render every session consumer on each flush. Only the running-turn
 * overlay and live subagent transcripts subscribe here.
 */
const StreamingOverlayContext = createContext<StreamingOverlay>(EMPTY_OVERLAY)

/**
 * Latest AI-generated progress line per running subagent, keyed by the
 * Task/Agent tool_use id. Provided here rather than on SessionContext because
 * it has exactly the same audience as the overlay — the live subagent panes —
 * and updates on the same lifecycle (it is dropped whenever the overlay is).
 * Its own context so a ~30s summary does not re-render overlay consumers.
 */
const AgentProgressContext = createContext<Record<string, string>>(EMPTY_AGENT_PROGRESS)

interface StreamingOverlayProviderProps {
  value: StreamingOverlay
  agentProgress?: Record<string, string>
  children: ReactNode
}

export function StreamingOverlayProvider({
  value,
  agentProgress = EMPTY_AGENT_PROGRESS,
  children,
}: StreamingOverlayProviderProps): ReactNode {
  return (
    <StreamingOverlayContext.Provider value={value}>
      <AgentProgressContext.Provider value={agentProgress}>
        {children}
      </AgentProgressContext.Provider>
    </StreamingOverlayContext.Provider>
  )
}

export function useStreamingOverlay(): StreamingOverlay {
  return useContext(StreamingOverlayContext)
}

/** The running subagent's current progress line, or null before the first fork lands. */
export function useAgentProgress(toolUseId: string): string | null {
  return useContext(AgentProgressContext)[toolUseId] ?? null
}
