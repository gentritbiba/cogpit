import { useState, useEffect, useCallback } from "react"
import { authFetch } from "@/lib/auth"

// ── Types ────────────────────────────────────────────────────────────────────

export interface ScriptEntry {
  name: string
  command: string
  dir: string
  dirLabel: string
  isCommon: boolean
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useScriptDiscovery(projectDir: string | null | undefined) {
  const [scripts, setScripts] = useState<ScriptEntry[]>([])
  const [loading, setLoading] = useState(false)

  const fetchScripts = useCallback(async () => {
    if (!projectDir) {
      setScripts([])
      return
    }

    setLoading(true)
    try {
      const res = await authFetch(
        `/api/scripts?dir=${encodeURIComponent(projectDir)}`
      )
      if (res.ok) {
        const data: ScriptEntry[] = await res.json()
        setScripts(data)
      }
    } catch {
      // ignore fetch errors
    } finally {
      setLoading(false)
    }
  }, [projectDir])

  useEffect(() => {
    fetchScripts()
  }, [fetchScripts])

  return { scripts, loading, refresh: fetchScripts }
}
