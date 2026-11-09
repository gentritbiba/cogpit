import { useCallback, useRef, useSyncExternalStore } from "react"

/** A reducer held outside React, so a component re-renders only for the slice it selects. */
export interface Store<S, A> {
  getState(): S
  dispatch(action: A): void
  subscribe(listener: () => void): () => void
}

export function createStore<S, A>(reducer: (state: S, action: A) => S, initialState: S): Store<S, A> {
  let state = initialState
  const listeners = new Set<() => void>()
  return {
    getState: () => state,
    dispatch(action) {
      const next = reducer(state, action)
      if (next === state) return
      state = next
      for (const listener of [...listeners]) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/**
 * Subscribes to `select(state)`. The component re-renders only when the
 * selected value changes by `isEqual`; an equal value keeps the previous one,
 * so selecting a fresh object or array is safe.
 */
export function useStoreSelector<S, A, T>(
  store: Store<S, A>,
  select: (state: S) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const last = useRef<{ state: S; select: (state: S) => T; value: T } | null>(null)
  const getSnapshot = useCallback(() => {
    const state = store.getState()
    const previous = last.current
    if (previous && previous.state === state && previous.select === select) return previous.value
    const selected = select(state)
    const value = previous && isEqual(previous.value, selected) ? previous.value : selected
    last.current = { state, select, value }
    return value
  }, [store, select, isEqual])
  return useSyncExternalStore(store.subscribe, getSnapshot)
}

/** Equal when both objects hold the same values under the same keys. */
export function shallowEqual<T extends object>(a: T, b: T): boolean {
  if (a === b) return true
  const keys = Object.keys(a) as Array<keyof T>
  return keys.length === Object.keys(b).length && keys.every((key) => Object.is(a[key], b[key]))
}
