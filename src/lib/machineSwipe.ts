import { useSyncExternalStore } from "react"

/** Whether a sideways swipe (or horizontal scroll) moves between machines. On unless turned off. */
const STORAGE_KEY = "cogpit-machine-swipe"
const listeners = new Set<() => void>()

function read(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "off"
  } catch {
    return true
  }
}

let enabled = read()

export function setMachineSwipe(next: boolean): void {
  if (next === enabled) return
  enabled = next
  try {
    if (next) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, "off")
  } catch {
    // The choice still holds for this visit.
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useMachineSwipe(): boolean {
  return useSyncExternalStore(subscribe, () => enabled)
}
