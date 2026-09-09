import { useSyncExternalStore } from "react"
import { createNameStore } from "@/lib/nameStore"

interface SessionNamesResult {
  names: Record<string, string>
  rename: (sessionId: string, name: string) => void
}

const store = createNameStore("session-custom-names")

export const rename = store.rename

export function useSessionNames(): SessionNamesResult {
  const names = useSyncExternalStore(store.subscribe, store.getSnapshot)
  return { names, rename }
}
