import { createContext, useCallback, useContext, useMemo, useState, useSyncExternalStore, type ReactNode } from "react"
import type { ThinkingBlock } from "../../../shared/session/types"

type Listener = () => void
type Initial<T> = T | (() => T)

/**
 * What the reader did to the timeline that must outlive the rows showing it:
 * open folds, drafts, and content fetched on demand. Virtualization unmounts
 * rows that leave the viewport, so none of this can live in component state.
 */
export class TimelineStateStore {
  private readonly values = new Map<string, unknown>()
  private readonly listeners = new Map<string, Set<Listener>>()

  has(key: string): boolean {
    return this.values.has(key)
  }

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined
  }

  /** Stores a first value without notifying anyone; a later mount reads it back. */
  init<T>(key: string, value: T): void {
    if (!this.values.has(key)) this.values.set(key, value)
  }

  set<T>(key: string, value: T): void {
    if (this.values.has(key) && Object.is(this.values.get(key), value)) return
    this.values.set(key, value)
    this.listeners.get(key)?.forEach((listener) => listener())
  }

  /** Opens a disclosure, for navigation that has to reveal what it lands on. */
  open(key: string): void {
    this.set(key, true)
  }

  /** Opens every closed disclosure under `prefix` that `accept` takes; returns how many opened. */
  openClosed(prefix: string, accept: (key: string) => boolean): number {
    let opened = 0
    for (const [key, value] of this.values) {
      if (value !== false || !key.startsWith(prefix) || !accept(key)) continue
      this.set(key, true)
      opened++
    }
    return opened
  }

  subscribe(key: string, listener: Listener): () => void {
    let set = this.listeners.get(key)
    if (!set) this.listeners.set(key, set = new Set())
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(key)
    }
  }
}

const SESSION_STORES_KEPT = 12
const sessionStores = new Map<string, TimelineStateStore>()

/** The store of one session, kept across session switches for the few most recent. */
export function timelineStoreFor(sessionKey: string): TimelineStateStore {
  let store = sessionStores.get(sessionKey)
  if (store) {
    sessionStores.delete(sessionKey)
  } else {
    store = new TimelineStateStore()
    if (sessionStores.size >= SESSION_STORES_KEPT) sessionStores.delete(sessionStores.keys().next().value!)
  }
  sessionStores.set(sessionKey, store)
  return store
}

const StoreContext = createContext<TimelineStateStore | null>(null)
interface Scope {
  /** The turn key the scope chain started from. */
  root: string
  path: string
}

const ScopeContext = createContext<Scope | null>(null)

export function DisclosureProvider({ sessionKey, children }: { sessionKey?: string; children: ReactNode }) {
  const [owned] = useState(() => new TimelineStateStore())
  const store = sessionKey === undefined ? owned : timelineStoreFor(sessionKey)
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
}

export function useTimelineStore(): TimelineStateStore | null {
  return useContext(StoreContext)
}

/**
 * Prefixes every key below it with `id`. A turn is a root scope (its turn key);
 * blocks and nested parts add their own stable ids under it. An id that is
 * unique in the whole turn, like a tool call id, sits directly under the turn
 * (`underTurn`), so its state follows it when the blocks around it regroup.
 */
export function DisclosureScope({ id, root = false, underTurn = false, children }: {
  id: string
  root?: boolean
  underTurn?: boolean
  children: ReactNode
}) {
  const parent = useContext(ScopeContext)
  const scopeRoot = root || parent === null ? id : parent.root
  const path = root || parent === null ? id : `${underTurn ? parent.root : parent.path}:${id}`
  const scope = useMemo(() => ({ root: scopeRoot, path }), [scopeRoot, path])
  return <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>
}

/** `local` under the enclosing scope, or null outside any scope (state then stays local). */
export function useDisclosureKey(local: string | null): string | null {
  const scope = useContext(ScopeContext)
  return scope === null || local === null ? null : `${scope.path}:${local}`
}

/** The key of the turn whose row this is, or null outside a turn. */
export function useScopeTurnKey(): string | null {
  return useContext(ScopeContext)?.root ?? null
}

/** What find asks a turn to show: a tool call by id, or a run of thinking. */
export type RevealTarget = string | readonly ThinkingBlock[]

export function revealKey(turnKey: string): string {
  return `${turnKey}:reveal`
}

function resolve<T>(initial: Initial<T>): T {
  return typeof initial === "function" ? (initial as () => T)() : initial
}

const noSubscription = () => () => {}

/**
 * State kept in the session's timeline store under `key`. The first resolved
 * `initial` is stored, so a remount reads what the first mount decided. With no
 * store or no key it behaves like `useState`.
 */
export function useTimelineState<T>(key: string | null, initial: Initial<T>): [T, (next: T | ((current: T) => T)) => void] {
  const store = useContext(StoreContext)
  const shared = store !== null && key !== null
  const [local, setLocal] = useState<T>(() => (shared ? (undefined as T) : resolve(initial)))
  if (shared && !store.has(key)) store.init(key, resolve(initial))

  const subscribe = useCallback(
    (listener: Listener) => (shared ? store.subscribe(key, listener) : noSubscription()),
    [shared, store, key],
  )
  const value = useSyncExternalStore(subscribe, () => (shared ? store.get<T>(key) as T : local))

  const set = useCallback((next: T | ((current: T) => T)) => {
    if (!shared) {
      setLocal(next)
      return
    }
    const current = store.get<T>(key) as T
    store.set(key, typeof next === "function" ? (next as (current: T) => T)(current) : next)
  }, [shared, store, key])

  return [value, set]
}

export function useDisclosure(key: string | null, initial: Initial<boolean>): [boolean, (open: boolean | ((open: boolean) => boolean)) => void] {
  return useTimelineState(key, initial)
}

/** Text or answers the reader is still writing, kept when the row unmounts. */
export function useTimelineDraft<T = string>(key: string | null, initial: Initial<T>): [T, (next: T | ((current: T) => T)) => void] {
  return useTimelineState(key, initial)
}

/** The reveal request of the turn this sits in, for the group that holds its target to open itself. */
export function useRevealTarget(): RevealTarget | null {
  const turnKey = useScopeTurnKey()
  return useTimelineState<RevealTarget | null>(turnKey === null ? null : revealKey(turnKey), null)[0]
}
