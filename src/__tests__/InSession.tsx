import { useMemo, type ReactNode } from "react"
import { OpenSessionProvider, type ChatState, type SessionControls } from "@/contexts/SessionContext"
import { createSessionStore } from "@/hooks/useSessionState"
import type { SessionView } from "../../shared/session/sessionDigest"

const CHAT = { pendingMessages: [], consumePending: () => {} } as unknown as ChatState

/** `children` with `session` open in the app's own session provider; tests hand in only the controls they read. */
export function InSession({ session, controls = {}, children }: {
  session: SessionView | null
  controls?: Partial<SessionControls>
  children: ReactNode
}) {
  const store = useMemo(() => createSessionStore(session), [session])
  return (
    <OpenSessionProvider store={store} controls={controls as SessionControls} chat={CHAT} isLive={controls.isLive ?? false}>
      {children}
    </OpenSessionProvider>
  )
}
