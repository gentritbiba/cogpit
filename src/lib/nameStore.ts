import { deviceScopedKey } from "@/lib/device"

export interface NameStore {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => Record<string, string>
  rename: (key: string, name: string) => void
}

/**
 * Names are stored per device, and the device can change without a page
 * reload, so the snapshot is re-read on a device/identity switch — otherwise
 * the next rename would write the old device's names into the new device's
 * storage.
 */
export function createNameStore(storageKey: string): NameStore {
  function loadNames(): Record<string, string> {
    try {
      const raw = localStorage.getItem(deviceScopedKey(storageKey))
      return raw ? JSON.parse(raw) : {}
    } catch {
      return {}
    }
  }

  let currentNames = loadNames()
  const listeners = new Set<() => void>()

  function emit(): void {
    for (const listener of listeners) {
      listener()
    }
  }

  function reloadNames(): void {
    currentNames = loadNames()
    emit()
  }

  if (typeof window !== "undefined") {
    window.addEventListener("cogpit-device-changed", reloadNames)
    window.addEventListener("cogpit-identity-changed", reloadNames)
  }

  return {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => currentNames,
    rename: (key, name) => {
      const next = { ...currentNames }
      const trimmed = name.trim()
      if (trimmed) {
        next[key] = trimmed
      } else {
        delete next[key]
      }
      localStorage.setItem(deviceScopedKey(storageKey), JSON.stringify(next))
      currentNames = next
      emit()
    },
  }
}
