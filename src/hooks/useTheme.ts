import { useState, useCallback, useEffect } from "react"

export type ThemeId = "dark" | "oled" | "light"

const STORAGE_KEY = "cogpit-theme"

export interface ThemeDefinition {
  id: ThemeId
  name: string
  /** 5 elevation colors (0–4) for the swatch preview */
  swatches: string[]
}

export const themes: ThemeDefinition[] = [
  {
    id: "dark",
    name: "Default Dark",
    swatches: [
      "oklch(0.12 0.005 265)",
      "oklch(0.18 0.008 265)",
      "oklch(0.24 0.010 265)",
      "oklch(0.30 0.012 265)",
      "oklch(0.34 0.014 265)",
    ],
  },
  {
    id: "oled",
    name: "Deep OLED",
    swatches: [
      "oklch(0 0 0)",
      "oklch(0.08 0 0)",
      "oklch(0.14 0 0)",
      "oklch(0.18 0 0)",
      "oklch(0.22 0 0)",
    ],
  },
  {
    id: "light",
    name: "Light",
    swatches: [
      "oklch(0.965 0 0)",
      "oklch(0.990 0 0)",
      "oklch(1.000 0 0)",
      "oklch(1.000 0 0)",
      "oklch(1.000 0 0)",
    ],
  },
]

function getThemeClasses(id: ThemeId): string {
  switch (id) {
    case "dark": return "dark"
    case "oled": return "dark theme-oled"
    case "light": return ""
  }
}

export function useTheme() {
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
  const themeClasses = getThemeClasses(activeTheme)

  // Sync theme classes to <html> so CSS variable selectors (.dark) work globally
  useEffect(() => {
    const cl = document.documentElement.classList
    cl.remove("dark", "theme-oled")
    if (activeTheme === "dark") cl.add("dark")
    else if (activeTheme === "oled") cl.add("dark", "theme-oled")
  }, [activeTheme])

  return { theme, activeTheme, themeClasses, setTheme, setPreview: setPreviewId }
}
