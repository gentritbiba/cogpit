import { useState, useCallback, useEffect } from "react"
import type { ThemeContext } from "@/contexts/AppContext"
import { applyTheme, readSavedTheme, saveTheme, type ThemeId } from "@/lib/themes"

export function useTheme(): ThemeContext {
  const [theme, setThemeState] = useState(readSavedTheme)
  const [previewId, setPreviewId] = useState<ThemeId | null>(null)
  const setTheme = useCallback((id: ThemeId) => {
    saveTheme(id)
    setThemeState(id)
    setPreviewId(null)
  }, [])
  const activeTheme = previewId ?? theme
  useEffect(() => applyTheme(activeTheme), [activeTheme])
  return { theme, activeTheme, setTheme, setPreview: setPreviewId }
}
