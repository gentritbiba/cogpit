import { createContext, useContext, type ReactNode } from "react"
import { EMPTY_OVERLAY, type StreamingOverlay } from "@/lib/streamingOverlay"

/**
 * Dedicated context for the token-streaming overlay.
 *
 * Deliberately separate from SessionContext: the overlay updates at up to
 * ~13 Hz while a turn streams, and putting it on the session context would
 * re-render every session consumer on each flush. Only the running-turn
 * overlay and live subagent transcripts subscribe here.
 */
const StreamingOverlayContext = createContext<StreamingOverlay>(EMPTY_OVERLAY)

interface StreamingOverlayProviderProps {
  value: StreamingOverlay
  children: ReactNode
}

export function StreamingOverlayProvider({ value, children }: StreamingOverlayProviderProps): ReactNode {
  return (
    <StreamingOverlayContext.Provider value={value}>
      {children}
    </StreamingOverlayContext.Provider>
  )
}

export function useStreamingOverlay(): StreamingOverlay {
  return useContext(StreamingOverlayContext)
}
