import { useSyncExternalStore } from "react"
import { deviceScopedKey } from "@/lib/device"

interface ProjectNamesResult {
  names: Record<string, string>
  rename: (dirName: string, name: string) => void
}

const STORAGE_KEY = "project-custom-names"

// Keys are device-scoped (computed lazily) so custom project names never bleed
// between devices — the same dirName can be renamed differently per device.
function loadNames(): Record<string, string> {
  try {
    const raw = localStorage.getItem(deviceScopedKey(STORAGE_KEY))
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function saveNames(names: Record<string, string>): void {
  localStorage.setItem(deviceScopedKey(STORAGE_KEY), JSON.stringify(names))
}

// Module-level store shared across all hook instances
let currentNames: Record<string, string> = loadNames()
const listeners = new Set<() => void>()

// The active device can change without a full page reload (in-app switch). The
// module-level snapshot is read once at import, so re-load it for the new
// device's scoped key and notify subscribers — otherwise a rename would merge
// the previous device's names into the new device's storage.
if (typeof window !== "undefined") {
  window.addEventListener("cogpit-device-changed", () => {
    currentNames = loadNames()
    for (const listener of listeners) {
      listener()
    }
  })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): Record<string, string> {
  return currentNames
}

export function renameProject(dirName: string, name: string): void {
  const next = { ...currentNames }
  const trimmed = name.trim()
  if (trimmed) {
    next[dirName] = trimmed
  } else {
    delete next[dirName]
  }
  saveNames(next)
  currentNames = next
  for (const listener of listeners) {
    listener()
  }
}

export function useProjectNames(): ProjectNamesResult {
  const names = useSyncExternalStore(subscribe, getSnapshot)
  return { names, rename: renameProject }
}
