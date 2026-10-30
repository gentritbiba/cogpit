type CancellationListener = (sessionId: string | null) => void
const listeners = new Set<CancellationListener>()

export function subscribeSessionCancellation(listener: CancellationListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Null ends unattended continuations for every session (kill all). */
export function publishSessionCancellation(sessionId: string | null): void {
  for (const listener of listeners) listener(sessionId)
}
