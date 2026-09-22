import { useEffect, useState } from "react"
import type { PluginContext, PluginManifest } from "@cogpit/plugin-contracts"
import type { PluginProjectSummary } from "../../shared/contracts/pluginManagement"
import themeCss from "../../packages/plugin-ui/theme.css?raw"

export const PLUGIN_THEME_TOKENS = [
  ...Array.from(themeCss.matchAll(/--color-[\w-]+:\s*var\((--[\w-]+)\)/g), (match) => match[1]),
  "--surface-opacity", "--surface-rgb", "--surface", "--surface-hover", "--radius", "--font-sans", "--font-mono",
]
type Presentation = Pick<PluginContext, "theme" | "locale" | "reducedMotion">

export function readPluginPresentation(): Presentation {
  const root = document.documentElement
  const styles = getComputedStyle(root)
  const tokens: Record<string, string> = {}
  for (const name of PLUGIN_THEME_TOKENS) {
    const value = styles.getPropertyValue(name).trim()
    if (value && new TextEncoder().encode(value).byteLength <= 256) tokens[name] = value
  }
  return {
    theme: { mode: root.classList.contains("dark") ? "dark" : "light", tokens },
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
