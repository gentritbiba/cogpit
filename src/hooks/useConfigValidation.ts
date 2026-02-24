import { useState, useCallback, useRef, useEffect } from "react"
import { authFetch } from "@/lib/auth"

export type ValidationStatus = "idle" | "validating" | "valid" | "invalid"

export function useConfigValidation() {
  const [status, setStatus] = useState<ValidationStatus>("idle")
  const [error, setError] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const validate = useCallback(async (value: string) => {
    if (!value.trim()) {
      setStatus("idle")
      setError(null)
      return
    }
    setStatus("validating")
    setError(null)
    try {
      const res = await authFetch(`/api/config/validate?path=${encodeURIComponent(value)}`)
      const data = await res.json()
      if (data.valid) {
        setStatus("valid")
        setError(null)
      } else {
        setStatus("invalid")
        setError(data.error || "Invalid path")
      }
    } catch {
      setStatus("invalid")
      setError("Failed to validate path")
    }
  }, [])

  const debouncedValidate = useCallback((value: string) => {
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => validate(value), 400)
  }, [validate])

  const reset = useCallback(() => {
    setStatus("idle")
    setError(null)
    clearTimeout(timerRef.current)
  }, [])

  const save = useCallback(async (path: string, networkOpts?: { networkAccess?: boolean; networkPassword?: string; terminalApp?: string; notificationSound?: boolean }): Promise<{ success: boolean; claudeDir?: string; error?: string }> => {
    try {
      const res = await authFetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claudeDir: path, ...networkOpts }),
      })
      const data = await res.json()
      if (res.ok && data.success) {
        return { success: true, claudeDir: data.claudeDir }
      }
      setError(data.error || "Failed to save")
      setStatus("invalid")
      return { success: false, error: data.error }
    } catch {
      setError("Failed to save configuration")
      return { success: false, error: "Network error" }
    }
  }, [])

  // Clean up debounce timer on unmount
  useEffect(() => {
    return () => clearTimeout(timerRef.current)
  }, [])

  return { status, error, debouncedValidate, validate, reset, save }
}
