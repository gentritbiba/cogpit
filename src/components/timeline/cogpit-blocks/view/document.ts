/**
 * The page an inline interactive view runs as. The agent writes HTML, CSS and
 * JavaScript; Cogpit wraps it with its theme, a base stylesheet so plain
 * markup already looks native, the libraries it asked for, and `window.cogpit`.
 */

import { VIEW_BASE_CSS, viewKitScript, scriptJson, type ViewTheme } from "../../../../../shared/views/frame"

/** Libraries a view can load. Each name is replaced in the sandbox by a blob URL of its code. */
export type ViewLibraryName = "d3" | "katex" | "three" | "three-core" | "three-orbit-controls"

const LIBRARY_TOKEN = /cogpit:lib\/([a-z0-9-]+)/g
const THREE_IMPORT = /["'](?:three|three\/addons\/controls\/OrbitControls\.js)["']/

const THREE_IMPORTS: Readonly<Record<string, string>> = {
  three: "cogpit:lib/three",
  "three/core": "cogpit:lib/three-core",
  "three/addons/controls/OrbitControls.js": "cogpit:lib/three-orbit-controls",
}

/** The libraries `html` uses: `cogpit:lib/<name>` sources, and Three.js through its usual bare imports. */
export function librariesUsed(html: string): Set<ViewLibraryName> {
  const used = new Set<ViewLibraryName>()
  for (const [, name] of html.matchAll(LIBRARY_TOKEN)) {
    if (name === "d3" || name === "katex" || name === "three") used.add(name)
  }
  if (used.has("three") || THREE_IMPORT.test(html)) {
    used.add("three")
    used.add("three-core")
    used.add("three-orbit-controls")
  }
  return used
}

export function viewTitle(html: string): string | null {
  const title = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim()
  return title || null
}

/** The whole document the sandbox writes: Cogpit's head, then the agent's markup as the body. */
export function composeViewDocument(html: string, theme: ViewTheme, libraries: ReadonlySet<ViewLibraryName>): string {
  const importMap = libraries.has("three") ? `<script type="importmap">${scriptJson({ imports: THREE_IMPORTS })}</script>` : ""
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<style>${VIEW_BASE_CSS}</style>${importMap}${viewKitScript(theme)}</head><body>${html}</body></html>`
}

export type ViewMessage =
  | { type: "ready" }
  | { type: "resize"; height: number }
  | { type: "error"; message: string }
  | { type: "open"; href: string }
  | { type: "ask"; text: string }

const MAX_TEXT = 4000

/** A message from a view's frame, or null when it is not one Cogpit acts on. */
export function readViewMessage(data: unknown): ViewMessage | null {
  if (typeof data !== "object" || data === null) return null
  const message = data as Record<string, unknown>
  if (message.cogpitView !== 1) return null
  switch (message.type) {
    case "ready":
      return { type: "ready" }
    case "resize":
      return typeof message.height === "number" && Number.isFinite(message.height) && message.height >= 0
        ? { type: "resize", height: message.height }
        : null
    case "error":
      return typeof message.message === "string" ? { type: "error", message: message.message.slice(0, 600) || "Unknown error" } : null
    case "open": {
      if (typeof message.href !== "string") return null
      try {
        const url = new URL(message.href)
        return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? { type: "open", href: url.href } : null
      } catch {
        return null
      }
    }
    case "ask": {
      const text = typeof message.text === "string" ? message.text.trim().slice(0, MAX_TEXT) : ""
      return text ? { type: "ask", text } : null
    }
    default:
      return null
  }
}
