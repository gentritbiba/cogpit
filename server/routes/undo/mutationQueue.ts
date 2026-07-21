let mutationTail: Promise<void> = Promise.resolve()

/** Serialize undo mutations so overlapping UI requests cannot interleave writes. */
export function enqueueUndoMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationTail.then(operation, operation)
  mutationTail = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}
