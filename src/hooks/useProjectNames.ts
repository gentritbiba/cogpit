import { useSyncExternalStore } from "react"

interface ProjectNamesResult {
  names: Record<string, string>
  rename: (dirName: string, name: string) => void
}

const STORAGE_KEY = "project-custom-names"

function loadNames(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function saveNames(names: Record<string, string>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(names))
}

// Module-level store shared across all hook instances
let currentNames: Record<string, string> = loadNames()
const listeners = new Set<() => void>()

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
