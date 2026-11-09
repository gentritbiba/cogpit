import { useMemo, type ReactNode } from "react"
import { OpenSessionProvider, type ChatState, type SessionControls } from "@/contexts/SessionContext"
import { createSessionStore } from "@/hooks/useSessionState"
import type { UseUndoRedoResult } from "@/hooks/useUndoRedo"
import type { SessionView } from "../../shared/session/sessionDigest"

const CHAT = { pendingMessages: [], consumePending: () => {} } as unknown as ChatState
const NO_UNDO = { enabled: false, requestUndo: () => {} } as unknown as UseUndoRedoResult

/** `children` with `session` open in the app's own session provider, from `controls.sessionSource`; tests hand in only the controls they read. */
export function InSession({ session, controls = {}, children }: {
  session: SessionView | null
  controls?: Partial<SessionControls>
  children: ReactNode
}) {
  const source = controls.sessionSource ?? null
  const store = useMemo(() => {
    const opened = createSessionStore(session)
    if (session && source) opened.dispatch({ type: "LOAD_SESSION", session, source, isMobile: false })
    return opened
  }, [session, source])
  const withDefaults = useMemo(() => ({ undoRedo: NO_UNDO, actions: {}, ...controls }) as SessionControls, [controls])
  return (
    <OpenSessionProvider store={store} controls={withDefaults} chat={CHAT} isLive={controls.isLive ?? false}>
      {children}
    </OpenSessionProvider>
  )
}
