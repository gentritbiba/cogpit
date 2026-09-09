import { useState, useCallback, useEffect } from "react"
import type { ThemeContext } from "@/contexts/AppContext"

export type ThemeId = "dark" | "oled" | "light"

const STORAGE_KEY = "cogpit-theme"

interface ThemeDefinition {
  id: ThemeId
  name: string
  /** Core surface colors shown in the theme preview. */
  swatches: string[]
}

export const themes: ThemeDefinition[] = [
  {
    id: "dark",
    name: "Default Dark",
    swatches: [
      "oklch(0.105 0 0)",
      "oklch(0.13 0 0)",
      "oklch(0.16 0 0)",
      "oklch(0.2 0 0)",
      "oklch(0.24 0 0)",
    ],
  },
  {
    id: "oled",
    name: "Deep OLED",
    swatches: [
      "oklch(0 0 0)",
      "oklch(0.08 0 0)",
      "oklch(0.10 0 0)",
      "oklch(0.10 0 0)",
      "oklch(0.18 0 0)",
    ],
  },
  {
    id: "light",
    name: "Light",
    swatches: [
      "oklch(1 0 0)",
      "oklch(1 0 0)",
      "oklch(1 0 0)",
      "oklch(0.96 0 0)",
      "oklch(0.922 0 0)",
    ],
  },
]

export function useTheme(): ThemeContext {
  const [theme, setThemeState] = useState<ThemeId>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored === "dark" || stored === "oled" || stored === "light") return stored
    } catch { /* SSR / incognito fallback */ }
    return "dark"
  })

  const [previewId, setPreviewId] = useState<ThemeId | null>(null)

  const setTheme = useCallback((id: ThemeId) => {
    localStorage.setItem(STORAGE_KEY, id)
    setThemeState(id)
    setPreviewId(null)
  }, [])

  const activeTheme = previewId ?? theme

  // Sync theme classes to <html> so CSS variable selectors (.dark) work globally
  useEffect(() => {
    const cl = document.documentElement.classList
    cl.remove("dark", "theme-oled")
    if (activeTheme === "dark") cl.add("dark")
    else if (activeTheme === "oled") cl.add("dark", "theme-oled")
  }, [activeTheme])

  return { theme, activeTheme, setTheme, setPreview: setPreviewId }
}
