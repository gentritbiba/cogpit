export const themes = [
  {
    id: "layered",
    className: "dark theme-layered",
    name: "Layered Black",
    swatches: ["#000000", "#080808", "#0f0f0f", "#161616", "#1d1d1d"],
  },
  {
    id: "layered-light",
    className: "theme-layered",
    name: "Layered Light",
    swatches: ["#ffffff", "#f7f7f7", "#f0f0f0", "#e9e9e9", "#e2e2e2"],
  },
  {
    id: "dark",
    className: "dark",
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
    className: "dark theme-oled",
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
    className: "",
    name: "Light",
    swatches: [
      "oklch(1 0 0)",
      "oklch(1 0 0)",
      "oklch(1 0 0)",
      "oklch(0.96 0 0)",
      "oklch(0.922 0 0)",
    ],
  },
] as const

export type ThemeId = (typeof themes)[number]["id"]
const STORAGE_KEY = "cogpit-theme"
const themeClasses = [...new Set(themes.flatMap(theme => theme.className.split(" ").filter(Boolean)))]

export function readSavedTheme(): ThemeId {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    return themes.find(theme => theme.id === saved)?.id ?? "dark"
  } catch {
    return "dark"
  }
}

export function saveTheme(id: ThemeId): void {
  try { localStorage.setItem(STORAGE_KEY, id) } catch { /* Theme changes still work without storage. */ }
}

export function themeMode(id: ThemeId): "dark" | "light" {
  return themes.find(theme => theme.id === id)!.className.split(" ").includes("dark") ? "dark" : "light"
}

export function applyTheme(id: ThemeId): void {
  const theme = themes.find(theme => theme.id === id)!
  const root = document.documentElement
  root.classList.remove(...themeClasses)
  root.classList.add(...theme.className.split(" ").filter(Boolean))
  root.style.colorScheme = themeMode(id)
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.swatches[0])
}
