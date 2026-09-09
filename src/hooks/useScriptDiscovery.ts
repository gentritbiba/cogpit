import { useState, useEffect, useCallback } from "react"
import { authFetch } from "@/lib/auth"
import { useCapability } from "@/hooks/useCapability"
import type { ScriptEntry } from "../../shared/contracts/projectTools"

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useScriptDiscovery(projectDir: string | null | undefined) {
  const canAccessHostFiles = useCapability("hostFiles")
  const [scripts, setScripts] = useState<ScriptEntry[]>([])
  const [loading, setLoading] = useState(false)

  const fetchScripts = useCallback(async () => {
    if (!canAccessHostFiles || !projectDir) {
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
  }, [canAccessHostFiles, projectDir])

  useEffect(() => {
    fetchScripts()
  }, [fetchScripts])

  return { scripts, loading, refresh: fetchScripts }
}
