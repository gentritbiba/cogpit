import { parseThemeId, type ThemeId } from "../../shared/contracts/appearance"

export type { ThemeId }

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
] as const satisfies ReadonlyArray<{ id: ThemeId; className: string; name: string; swatches: readonly string[] }>

export const DEFAULT_THEME: ThemeId = "dark"

/** Where this browser kept its one theme before each machine had its own. */
const LEGACY_STORAGE_KEY = "cogpit-theme"
const themeClasses = [...new Set(themes.flatMap(theme => theme.className.split(" ").filter(Boolean)))]

function themeFor(id: ThemeId) {
  return themes.find(theme => theme.id === id) ?? themes.find(theme => theme.id === DEFAULT_THEME)!
}

/** The theme this browser used before themes belonged to machines, if it saved one. */
export function legacyTheme(): ThemeId | null {
  try {
    return parseThemeId(localStorage.getItem(LEGACY_STORAGE_KEY))
  } catch {
    return null
  }
}

export function themeMode(id: ThemeId): "dark" | "light" {
  return themeFor(id).className.split(" ").includes("dark") ? "dark" : "light"
}

/** The classes that give an element's subtree this theme (with `theme-scope`, see plugin-ui/theme.css). */
export function themeClassName(id: ThemeId): string {
  return themeFor(id).className
}

/** The page's background color in this theme, for the browser chrome around it. */
function themeCanvasColor(id: ThemeId): string {
  return themeFor(id).swatches[0]
}

/** Dress the whole document, and with it everything portaled to `<body>`, in this theme. */
export function applyTheme(id: ThemeId): void {
  const root = document.documentElement
  root.classList.remove(...themeClasses)
  root.classList.add(...themeClassName(id).split(" ").filter(Boolean))
  root.style.colorScheme = themeMode(id)
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeCanvasColor(id))
}
