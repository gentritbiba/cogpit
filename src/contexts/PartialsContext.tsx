import { createContext, useContext, type ReactNode } from "react"
import type { PartialAssistantMessage } from "@/lib/types"

/**
 * Dedicated context for in-flight partial assistant messages (streaming text
 * and thinking). Split out from `SessionContext` because partials tick at
 * ~60 Hz during streaming and every context value change forces every
 * consumer to re-render — without this split, the 16+ `useSessionContext`
 * consumers (ChatInput, SessionInfoBar, TurnSection, etc.) would all re-render
 * on every token, undoing the perf work in 63a5b51.
 *
 * Only `ConversationTimeline` needs to subscribe. Everything else reads
 * session data from `SessionContext`.
 */

export interface PartialsContextValue {
  partialMessages: Map<string, PartialAssistantMessage>
}

const PartialsContext = createContext<PartialsContextValue | null>(null)

interface PartialsProviderProps {
  value: PartialsContextValue
  children: ReactNode
}

export function PartialsProvider({ value, children }: PartialsProviderProps): ReactNode {
  return (
    <PartialsContext.Provider value={value}>
      {children}
    </PartialsContext.Provider>
  )
}

export function usePartials(): PartialsContextValue {
  const ctx = useContext(PartialsContext)
  if (!ctx) {
    throw new Error("usePartials must be used within a PartialsProvider")
  }
  return ctx
}
