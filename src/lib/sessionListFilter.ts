// ── Session list filter ─────────────────────────────────────────────────
//
// Which sessions every list shows, as the installed edition's filter says.
// Core never reads the filter: its key tells cached lists and requests apart,
// and its query rides along on every list request. Without an edition, or
// while its filter is off, lists are unfiltered.

import { useCallback, useMemo, useSyncExternalStore } from "react"
import { useEditionUi } from "@/edition/hooks"

export interface ListFilter {
  /** Null is the unfiltered list. */
  key: string | null
  query: Readonly<Record<string, string>>
}

const UNFILTERED: ListFilter = Object.freeze({ key: null, query: Object.freeze({}) })

function noSubscription(): () => void {
  return () => {}
}

function noKey(): string | null {
  return null
}

/** The filter every session list request carries; the same object until its key changes. */
export function useSessionListFilter(): ListFilter {
  const { sessionListFilter: store } = useEditionUi()
  const subscribe = useCallback(
    (listener: () => void) => store?.subscribe(listener) ?? noSubscription(),
    [store],
  )
  const getKey = useMemo(() => (store ? () => store.getKey() : noKey), [store])
  const key = useSyncExternalStore(subscribe, getKey, getKey)
  return useMemo(
    () => (store && key !== null ? { key, query: store.getQuery() } : UNFILTERED),
    [store, key],
  )
}

/** Every request for a session list goes through here; an unfiltered list adds nothing. */
export function listUrl(
  path: string,
  filter: ListFilter,
  query: Record<string, string> | URLSearchParams = {},
): string {
  const params = new URLSearchParams(query)
  for (const [name, value] of Object.entries(filter.query)) params.set(name, value)
  const search = params.toString()
  return search ? `${path}?${search}` : path
}

export function activeSessionsUrl(
  query: Record<string, string> | URLSearchParams,
  filter: ListFilter,
): string {
  return listUrl("/api/active-sessions", filter, query)
}
