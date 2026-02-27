import { useState, useCallback, useRef, useEffect } from "react"
import { copyToClipboard } from "@/lib/utils"

const FEEDBACK_DURATION_MS = 1500

/**
 * Copy text to clipboard and show a brief "copied" state.
 * Returns [copied, copy] where `copied` is true for 1.5s after a successful copy.
 */
export function useCopyWithFeedback(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const copy = useCallback(async (text: string) => {
    const ok = await copyToClipboard(text)
    if (!ok) return
    setCopied(true)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setCopied(false), FEEDBACK_DURATION_MS)
  }, [])

  return [copied, copy]
}
