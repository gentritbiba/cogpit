import { useEffect, useRef, useState } from "react"

export function useTeamLive(
  teamName: string | null,
  onUpdate: () => void
) {
  const [isLive, setIsLive] = useState(false)
  const onUpdateRef = useRef(onUpdate)
  onUpdateRef.current = onUpdate

  useEffect(() => {
    if (!teamName) {
      setIsLive(false)
      return
    }

    const url = `/api/team-watch/${encodeURIComponent(teamName)}`
    const es = new EventSource(url)
    let staleTimer: ReturnType<typeof setTimeout> | null = null

    const resetStaleTimer = () => {
      if (staleTimer) clearTimeout(staleTimer)
      staleTimer = setTimeout(() => setIsLive(false), 30000)
    }

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === "init") {
          resetStaleTimer()
        } else if (data.type === "update") {
          setIsLive(true)
          resetStaleTimer()
          onUpdateRef.current()
        }
      } catch {
        // ignore
      }
    }

    es.onerror = () => {
      setIsLive(false)
    }

    return () => {
      es.close()
      setIsLive(false)
      if (staleTimer) clearTimeout(staleTimer)
    }
  }, [teamName])

  return { isLive }
}
