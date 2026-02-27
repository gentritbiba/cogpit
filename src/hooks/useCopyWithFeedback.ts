import { useState, useCallback } from "react"
import { copyToClipboard } from "@/lib/utils"

const FEEDBACK_DURATION_MS = 1500

/**
 * Copy text to clipboard and show a brief "copied" state.
 * Returns [copied, copy] where `copied` is true for 1.5s after a successful copy.
 */
export function useCopyWithFeedback(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false)

  const copy = useCallback(async (text: string) => {
    const ok = await copyToClipboard(text)
    if (!ok) return
    setCopied(true)
    setTimeout(() => setCopied(false), FEEDBACK_DURATION_MS)
  }, [])

  return [copied, copy]
}
