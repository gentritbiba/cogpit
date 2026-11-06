import { createContext, useContext, useState, useEffect } from "react"

/** True inside content drawn on the opposite theme; see `InverseColorScheme`. */
export const InvertedColorScheme = createContext(false)

/**
 * Reactive dark mode detection via MutationObserver on <html class="dark">,
 * flipped inside an `InverseColorScheme`.
 * Safe for SSR/pre-rendering (guards against missing `document`).
 */
export function useIsDarkMode(): boolean {
  const inverted = useContext(InvertedColorScheme)
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
  return isDark !== inverted
}
