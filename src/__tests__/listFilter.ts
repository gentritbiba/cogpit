import { __installEditionUiForTest } from "@/edition/registry"
import type { SessionListFilter } from "@/edition/contract"

export interface StubListFilter {
  setKey(key: string | null): void
}

/**
 * Installs an edition UI whose one slot is a session list filter the test
 * drives. A key adds `filter=<key>` to every list request.
 */
export function installStubListFilter(
  key: string | null = null,
  slots: Pick<SessionListFilter, "Control" | "Empty"> = {},
): StubListFilter {
  let current = key
  const listeners = new Set<() => void>()
  const queries = new Map<string, Readonly<Record<string, string>>>()
  __installEditionUiForTest({
    sessionListFilter: {
      ...slots,
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      getKey: () => current,
      getQuery() {
        if (current === null) return {}
        let query = queries.get(current)
        if (!query) {
          query = { filter: current }
          queries.set(current, query)
        }
        return query
      },
    },
  })
  return {
    setKey(next) {
      current = next
      for (const listener of listeners) listener()
    },
  }
}
