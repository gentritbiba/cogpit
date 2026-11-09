import type { SessionView } from "../../shared/session/sessionDigest"

/** Mocks hand in partial context values, so the session is taken as whatever the mock returns. */
type ContextHook = () => object | null | undefined

interface SessionContextMock {
  useSessionContext?: ContextHook
  useSessionContextOptional?: ContextHook
  [hook: string]: unknown
}

/**
 * Completes a `@/contexts/SessionContext` module mock: the controls hooks and
 * `useOpenSession` read the same value the mock's session context returns.
 */
export function withSessionHooks<T extends SessionContextMock>(mock: T) {
  const context: ContextHook = () => (mock.useSessionContext ?? mock.useSessionContextOptional)?.() ?? null
  return {
    useSessionControls: context,
    useSessionControlsOptional: context,
    useOpenSession: <V,>(select: (session: SessionView | null) => V) => select(((context() as { session?: SessionView } | null)?.session ?? null)),
    ...mock,
  }
}
