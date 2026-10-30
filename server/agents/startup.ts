import { finishSessionStartup, type StartSessionRequest } from "./runtimeTypes"

const failures = new WeakSet<object>()
export const isStartupFailure = (error: unknown): boolean => typeof error === "object" && error !== null && failures.has(error)

/** A rejected readiness gate is a startup failure, never a fallback to another transport. */
export async function beforeFirstTurn(request: StartSessionRequest, identity: { sessionId?: string; cwd: string; nativeWorktree?: boolean }): Promise<void> {
  try {
    request.signal?.throwIfAborted()
    await request.beforeFirstTurn?.(identity)
    request.signal?.throwIfAborted()
    if (identity.sessionId) finishSessionStartup(identity.sessionId)
  } catch (error) {
    if (identity.sessionId) finishSessionStartup(identity.sessionId)
    if (typeof error === "object" && error !== null) failures.add(error)
    throw error
  }
}
