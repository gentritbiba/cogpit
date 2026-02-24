import { useState, useEffect } from "react"
import { authFetch } from "@/lib/auth"

export interface BgAgent {
  agentId: string
  dirName: string
  fileName: string
  parentSessionId: string
  modifiedAt: number
  isActive: boolean
  preview: string
}

export function useBackgroundAgents(cwd: string | null): BgAgent[] {
  const [agents, setAgents] = useState<BgAgent[]>([])

  useEffect(() => {
    if (!cwd) {
      setAgents([])
      return
    }

    let cancelled = false

    async function fetchAgents() {
      try {
        const res = await authFetch(
          `/api/background-agents?cwd=${encodeURIComponent(cwd!)}`
        )
        if (cancelled) return
        if (res.ok) {
          const data: BgAgent[] = await res.json()
          setAgents(data)
        }
      } catch {
        // ignore
      }
    }

    fetchAgents()
    const interval = setInterval(fetchAgents, 5_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [cwd])

  return agents
}
