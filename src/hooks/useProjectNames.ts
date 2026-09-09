import { useSyncExternalStore } from "react"
import { createNameStore } from "@/lib/nameStore"

interface ProjectNamesResult {
  names: Record<string, string>
  rename: (dirName: string, name: string) => void
}

const store = createNameStore("project-custom-names")

export const renameProject = store.rename

export function useProjectNames(): ProjectNamesResult {
  const names = useSyncExternalStore(store.subscribe, store.getSnapshot)
  return { names, rename: renameProject }
}
