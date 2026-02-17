import { useState, useCallback } from "react"

export function useKillAll() {
  const [killing, setKilling] = useState(false)

  const handleKillAll = useCallback(async () => {
    setKilling(true)
    try {
      await fetch("/api/kill-all", { method: "POST" })
    } catch { /* ignore */ }
    setTimeout(() => setKilling(false), 1500)
  }, [])

  return { killing, handleKillAll }
}
