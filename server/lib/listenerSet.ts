export interface ListenerSet<T> {
  /** Subscribe; the returned function unsubscribes. */
  add(listener: (value: T) => void): () => void
  /** Notify the listeners subscribed when the emit began. */
  emit(value: T): void
  clear(): void
}

/**
 * Synchronous subscribers for a module's change events. A listener that throws
 * goes to `onError` and never stops the others, or the code that emitted.
 */
export function listenerSet<T>(onError: (error: unknown) => void): ListenerSet<T> {
  const listeners = new Set<(value: T) => void>()
  return {
    add(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    emit(value) {
      for (const listener of [...listeners]) {
        try {
          listener(value)
        } catch (error) {
          onError(error)
        }
      }
    },
    clear() {
      listeners.clear()
    },
  }
}
