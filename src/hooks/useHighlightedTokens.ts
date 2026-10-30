import { useEffect, useState } from "react"
import { highlightCode, type ThemedToken } from "@/lib/shiki"

/** Content/theme identities fence even the render before effect cleanup runs. */
export function useHighlightedTokens(code: string, lang: string | null, isDark: boolean, debounceMs = 0): ThemedToken[][] | null {
  const [highlighted, setHighlighted] = useState<{
    code: string; lang: string; isDark: boolean; tokens: ThemedToken[][] | null
  } | null>(null)
  useEffect(() => {
    if (!lang) return
    const controller = new AbortController()
    const request = () => {
      void highlightCode(code, lang, isDark, controller.signal).then(tokens => {
        if (!controller.signal.aborted) setHighlighted({ code, lang, isDark, tokens })
      }).catch(() => undefined)
    }
    const timer = debounceMs > 0 ? setTimeout(request, debounceMs) : undefined
    if (!debounceMs) request()
    return () => { clearTimeout(timer); controller.abort() }
  }, [code, lang, isDark, debounceMs])
  return highlighted?.code === code && highlighted.lang === lang && highlighted.isDark === isDark ? highlighted.tokens : null
}
