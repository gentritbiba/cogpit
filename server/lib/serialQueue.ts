/**
 * One-at-a-time promise chain for the stores that persist module state to a
 * single file: every operation observes the previous one's committed result.
 */

export interface SerialQueue {
  /** Run `operation` once every previously enqueued one has settled. */
  run<T>(operation: () => Promise<T>): Promise<T>
  /** Drop the chain. For test resets, never for production state. */
  reset(): void
}

export function serialQueue(): SerialQueue {
  let tail: Promise<void> = Promise.resolve()
  return {
    run<T>(operation: () => Promise<T>): Promise<T> {
      const result = tail.then(operation)
      // A rejected operation belongs to its caller. Keep a handled tail so
      // later operations still run rather than inheriting the rejection.
      tail = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    },
    reset() {
      tail = Promise.resolve()
    },
  }
}

/** Swap a live map's contents for `next`, keeping the map identity. */
export function replaceAll<K, V>(target: Map<K, V>, next: ReadonlyMap<K, V>): void {
  target.clear()
  for (const [key, value] of next) target.set(key, value)
}
