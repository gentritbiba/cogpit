import { useState, useEffect, useCallback, useRef } from "react"
import { authFetch } from "@/lib/auth"

export interface SlashSuggestion {
  name: string
  description: string
  type: "command" | "skill"
  source: "project" | "user" | string
  filePath: string
}

export function useSlashSuggestions(cwd: string | undefined) {
  const [suggestions, setSuggestions] = useState<SlashSuggestion[]>([])
  const [loading, setLoading] = useState(false)
  const fetchedCwdRef = useRef<string | undefined>(undefined)

  // Fetch suggestions when cwd changes
  useEffect(() => {
    if (fetchedCwdRef.current === cwd) return
    fetchedCwdRef.current = cwd

    setLoading(true)
    const params = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""
    authFetch(`/api/slash-suggestions${params}`)
      .then((r) => r.json())
      .then((data) => setSuggestions(data.suggestions || []))
      .catch(() => setSuggestions([]))
      .finally(() => setLoading(false))
  }, [cwd])

  const expandCommand = useCallback(
    async (filePath: string, args: string): Promise<string | null> => {
      try {
        const res = await authFetch("/api/expand-command", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filePath, args }),
        })
        if (!res.ok) return null
        const data = await res.json()
        return data.content || null
      } catch {
        return null
      }
    },
    [],
  )

  return { suggestions, loading, expandCommand }
}
