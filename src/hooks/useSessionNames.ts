import { useSyncExternalStore } from "react"
import { deviceScopedKey } from "@/lib/device"

interface SessionNamesResult {
  names: Record<string, string>
  rename: (sessionId: string, name: string) => void
}

const STORAGE_KEY = "session-custom-names"

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

if (typeof window !== "undefined") {
  const reloadNames = () => {
    currentNames = loadNames()
    for (const listener of listeners) listener()
  }
  window.addEventListener("cogpit-device-changed", reloadNames)
  window.addEventListener("cogpit-identity-changed", reloadNames)
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

export function rename(sessionId: string, name: string): void {
  const next = { ...currentNames }
  const trimmed = name.trim()
  if (trimmed) {
    next[sessionId] = trimmed
  } else {
    delete next[sessionId]
  }
  saveNames(next)
  currentNames = next
  for (const listener of listeners) {
    listener()
  }
}

export function useSessionNames(): SessionNamesResult {
  const names = useSyncExternalStore(subscribe, getSnapshot)
  return { names, rename }
}
