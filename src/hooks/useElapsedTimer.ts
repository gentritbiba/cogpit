import { useState, useEffect, useRef } from "react"

/**
 * Track elapsed seconds since `active` became true.
 * Resets to 0 when `active` flips to false.
 */
export function useElapsedTimer(active: boolean): number {
  const connectedAtRef = useRef<number | null>(null)
  const [elapsedSec, setElapsedSec] = useState(0)

  useEffect(() => {
    if (!active) {
      connectedAtRef.current = null
      setElapsedSec(0)
      return
    }
    connectedAtRef.current = Date.now()
    setElapsedSec(0)
    const interval = setInterval(() => {
      if (connectedAtRef.current !== null) {
        setElapsedSec(Math.floor((Date.now() - connectedAtRef.current) / 1000))
      }
    }, 1000)
    return () => clearInterval(interval)
  }, [active])

  return elapsedSec
}
