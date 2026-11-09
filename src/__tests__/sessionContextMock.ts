import { act } from "@testing-library/react"
import { afterEach } from "vitest"
import { createSessionStore, useSessionSelector, useShownSession } from "@/hooks/useSessionState"
import type { SessionView } from "../../shared/session/sessionDigest"

/** Mocks hand in partial context values; the session itself comes from `showSession`. */
type ContextHook = () => object | null | undefined

interface SessionContextMock {
  useSessionContext?: ContextHook
  useSessionContextOptional?: ContextHook
  [hook: string]: unknown
}

/** The open session behind the mocked hooks, in a real store the components subscribe to; each test starts with none. */
let store = createSessionStore()
afterEach(() => { store = createSessionStore() })
const SOURCE = { dirName: "project", fileName: "session.jsonl", watchOffset: 0, loadId: 1 }

/**
 * Opens `session` (a partial one is fine) in that store, or closes it. A
 * mounted component sees it only if it subscribes to what changed.
 */
export function showSession(session: object | null): void {
  act(() => store.dispatch(session
    ? { type: "LOAD_SESSION", session: session as SessionView, source: SOURCE, isMobile: false }
    : { type: "CLOSE_SESSION", isMobile: false }))
}

/** The session `showSession` last opened. */
export function shownSession(): SessionView | null {
  return store.getState().session
}

/**
 * Completes a `@/contexts/SessionContext` module mock: the controls hooks
 * return the mock's context value, and the session in that value and in
 * `useOpenSession` comes from the store `showSession` drives. The context
 * hands it over as the real provider does, as the deferred copy on screen.
 */
export function withSessionHooks<T extends SessionContextMock>(mock: T) {
  const controls = (hook: ContextHook | undefined) => () => {
    const value = hook?.() ?? null
    if (value && "session" in value) throw new Error("Set the session with showSession(), not in the mocked context")
    return value
  }
  const withSession = (hook: ContextHook | undefined) => () => {
    const { session, sessionChangeKey, activeTurnIndex, activeToolCallId } = useShownSession(store)
    const value = controls(hook)()
    return value && { ...value, session, sessionChangeKey, activeTurnIndex, activeToolCallId }
  }
  const context = controls(mock.useSessionContext ?? mock.useSessionContextOptional)
  return {
    useSessionControls: context,
    useSessionControlsOptional: context,
    useOpenSession: <V,>(select: (session: SessionView | null) => V, isEqual?: (a: V, b: V) => boolean) => useSessionSelector(store, select, isEqual),
    ...mock,
    ...(mock.useSessionContext ? { useSessionContext: withSession(mock.useSessionContext) } : {}),
    ...(mock.useSessionContextOptional ? { useSessionContextOptional: withSession(mock.useSessionContextOptional) } : {}),
  }
}
