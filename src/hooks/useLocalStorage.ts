import { useState, useCallback } from "react"

/**
 * React hook for state persisted to localStorage.
 *
 * Returns [value, setValue] like useState. Reads from localStorage on mount;
 * writes back on every set. Cross-tab sync is NOT included (deliberate scope).
 *
 * @param key - localStorage key
 * @param defaultValue - returned if key absent or JSON parse fails
 */
export function useLocalStorage<T>(
  key: string,
  defaultValue: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  const [storedValue, setStoredValue] = useState<T>(() => {
    // SSR safety: if window is not available, return the default
    if (typeof window === "undefined") return defaultValue
    try {
      const raw = localStorage.getItem(key)
      if (raw === null) return defaultValue
      return JSON.parse(raw) as T
    } catch {
      // JSON parse failure falls back to defaultValue
      return defaultValue
    }
  })

  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      setStoredValue((prev) => {
        const next = typeof value === "function" ? (value as (prev: T) => T)(prev) : value
        try {
          localStorage.setItem(key, JSON.stringify(next))
        } catch (err) {
          // JSON stringify failure: log and skip the write rather than crash
          console.warn(`useLocalStorage: failed to serialize value for key "${key}"`, err)
        }
        return next
      })
    },
    [key],
  )

  return [storedValue, setValue]
}
