import { useState, useEffect } from "react"

/**
 * Reactive dark mode detection via MutationObserver on <html class="dark">.
 * Safe for SSR/pre-rendering (guards against missing `document`).
 */
export function useIsDarkMode() {
  const [isDark, setIsDark] = useState(
    () => typeof document !== "undefined" && document.documentElement.classList.contains("dark")
  )
  useEffect(() => {
    const el = document.documentElement
    const update = () => setIsDark(el.classList.contains("dark"))
    const obs = new MutationObserver(update)
    obs.observe(el, { attributes: true, attributeFilter: ["class"] })
    return () => obs.disconnect()
  }, [])
  return isDark
}
