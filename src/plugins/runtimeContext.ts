import { useEffect, useState } from "react"
import type { PluginContext, PluginManifest } from "@cogpit/plugin-contracts"
import type { PluginProjectSummary } from "../../shared/contracts/pluginManagement"
import themeCss from "../../packages/plugin-ui/theme.css?raw"

export const PLUGIN_THEME_TOKENS = [
  ...Array.from(themeCss.matchAll(/--color-[\w-]+:\s*var\((--[\w-]+)\)/g), (match) => match[1]),
  "--surface-opacity", "--surface-rgb", "--surface", "--surface-hover", "--radius", "--font-sans", "--font-mono",
]
type Presentation = Pick<PluginContext, "theme" | "locale" | "reducedMotion">

function themeTokens(element: Element): Record<string, string> {
  const styles = getComputedStyle(element)
  const tokens: Record<string, string> = {}
  for (const name of PLUGIN_THEME_TOKENS) {
    const value = styles.getPropertyValue(name).trim()
    if (value && new TextEncoder().encode(value).byteLength <= 256) tokens[name] = value
  }
  return tokens
}

/**
 * The open theme's colors and those of its opposite mode, for a page shown outside Cogpit. The opposite comes from a
 * hidden element that flips the mode, so it is that mode's default palette rather than a variant such as OLED.
 */
export function readLightAndDarkTokens(): { light: Record<string, string>; dark: Record<string, string> } {
  const root = document.documentElement
  const dark = root.classList.contains("dark")
  const probe = document.createElement("div")
  probe.className = dark ? "color-scheme-inverse" : "dark"
  probe.hidden = true
  document.body.append(probe)
  try {
    const current = themeTokens(root), opposite = themeTokens(probe)
    return dark ? { light: opposite, dark: current } : { light: current, dark: opposite }
  } finally { probe.remove() }
}

export function readPluginPresentation(): Presentation {
  const root = document.documentElement
  return {
    theme: { mode: root.classList.contains("dark") ? "dark" : "light", tokens: themeTokens(root) },
    locale: (root.lang || navigator.language || "en").slice(0, 64),
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  }
}

export function pluginPanelContext(manifest: PluginManifest, project: PluginProjectSummary | null, visible: boolean, presentation: Presentation, sessionHandle: string | null = null): PluginContext {
  let name = ""
  for (const character of project?.name.trim() ?? "") {
    if (name.length + character.length > 128) break
    if (character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127) name += character
  }
  // Packages built against contracts 1.0.0 validate their context strictly, so
  // the key only exists for plugins that asked for it.
  const session = manifest.permissions.context.includes("session.identity") ? { session: sessionHandle ? { handle: sessionHandle } : null } : {}
  return {
    ...presentation,
    project: project && manifest.permissions.context.includes("project.identity") ? { id: project.id, name: name.trim() || "Project" } : null,
    visible,
    ...session,
  }
}

export function usePluginPresentation(): Presentation {
  const [presentation, setPresentation] = useState(readPluginPresentation)
  useEffect(() => {
    const update = () => {
      const next = readPluginPresentation()
      setPresentation((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next)
    }
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "lang"] })
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)")
    motion.addEventListener("change", update)
    window.addEventListener("languagechange", update)
    return () => { observer.disconnect(); motion.removeEventListener("change", update); window.removeEventListener("languagechange", update) }
  }, [])
  return presentation
}
