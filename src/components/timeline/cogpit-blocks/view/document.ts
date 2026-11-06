/**
 * The page an interactive view runs as. The agent writes HTML, CSS and
 * JavaScript; Cogpit wraps it with its theme, a base stylesheet so plain
 * markup already looks native, the libraries it asked for, and `window.cogpit`.
 */

export interface ViewTheme {
  mode: "light" | "dark"
  tokens: Record<string, string>
}

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

const BASE_CSS = `*,*::before,*::after{box-sizing:border-box}
html{background:var(--card);color:var(--card-foreground,var(--foreground));font:13.5px/1.55 var(--font-sans,system-ui,sans-serif);-webkit-font-smoothing:antialiased}
body{margin:0;padding:16px}
h1,h2,h3,h4{margin:0 0 .5em;line-height:1.25;font-weight:600}
h1{font-size:1.3em}h2{font-size:1.15em}h3{font-size:1.02em}
p{margin:0 0 .75em}
a{color:var(--primary)}
code,kbd,pre{font-family:var(--font-mono,ui-monospace,monospace);font-size:.92em}
pre{margin:0 0 .75em;padding:10px 12px;overflow:auto;border-radius:calc(var(--radius,10px) - 2px);background:var(--muted)}
button{font:inherit;cursor:pointer;padding:5px 12px;border-radius:calc(var(--radius,10px) - 2px);border:1px solid var(--border);background:var(--secondary);color:var(--secondary-foreground)}
button:hover{background:var(--accent);color:var(--accent-foreground)}
button.primary{background:var(--primary);color:var(--primary-foreground);border-color:transparent}
button:disabled{opacity:.5;cursor:default}
input,select,textarea{font:inherit;color:inherit;background:var(--background);border:1px solid var(--input,var(--border));border-radius:calc(var(--radius,10px) - 2px);padding:4px 8px}
input[type=range],input[type=checkbox],input[type=radio]{accent-color:var(--primary)}
input[type=range]{padding:0;border:0;background:none}
label{display:inline-flex;align-items:center;gap:6px}
table{border-collapse:collapse;width:100%}
th,td{padding:6px 8px;border-bottom:1px solid var(--border);text-align:left}
th{font-weight:600;color:var(--muted-foreground)}
.muted{color:var(--muted-foreground)}
math{font-size:1.1em}`

/**
 * Runs first inside the sandbox. Everything it posts is untrusted by the
 * parent, since the view's own code can post the same messages.
 */
const KIT = String.raw`(initialTheme) => {
  const host = window.parent
  const root = document.documentElement
  const post = (message) => host.postMessage({ cogpitView: 1, ...message }, "*")
  const report = (error) => post({ type: "error", message: String(error?.message ?? error ?? "Unknown error") })
  addEventListener("error", (event) => report(event.error ?? event.message))
  addEventListener("unhandledrejection", (event) => report(event.reason))
  let theme = initialTheme
  let applied = []
  const themeListeners = new Set()
  const applyTheme = (next) => {
    theme = next
    root.classList.toggle("dark", next.mode === "dark")
    root.style.colorScheme = next.mode
    for (const name of applied) root.style.removeProperty(name)
    applied = Object.keys(next.tokens)
    for (const [name, value] of Object.entries(next.tokens)) root.style.setProperty(name, value)
    for (const listener of themeListeners) {
      try { listener(next) } catch (error) { report(error) }
    }
  }
  addEventListener("message", (event) => {
    if (event.source === host && event.data?.type === "cogpit-view:theme" && event.data.theme) applyTheme(event.data.theme)
  })
  let lastHeight = -1
  new ResizeObserver(() => {
    const height = Math.ceil(root.getBoundingClientRect().height)
    if (height !== lastHeight) post({ type: "resize", height: (lastHeight = height) })
  }).observe(root)
  document.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null
    if (!link || (link.getAttribute("href") ?? "").startsWith("#")) return
    event.preventDefault()
    post({ type: "open", href: link.href })
  }, true)
  const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true })
  const color = (name) => {
    const value = getComputedStyle(root).getPropertyValue(name.startsWith("--") ? name : "--" + name).trim()
    if (!value || !probe) return value
    probe.clearRect(0, 0, 1, 1)
    probe.fillStyle = value
    probe.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data
    return a === 255 ? "#" + [r, g, b].map((part) => part.toString(16).padStart(2, "0")).join("") : "rgba(" + r + ", " + g + ", " + b + ", " + (a / 255).toFixed(3) + ")"
  }
  window.cogpit = Object.freeze({
    get theme() { return theme },
    color,
    onTheme(listener) { themeListeners.add(listener); return () => themeListeners.delete(listener) },
    ask(text) { post({ type: "ask", text: String(text) }) },
  })
  applyTheme(initialTheme)
}`

/** A value safe to put inside an inline `<script>`: no `</script>` or comment openers survive. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c")
}

/** The whole document the sandbox writes: Cogpit's head, then the agent's markup as the body. */
export function composeViewDocument(html: string, theme: ViewTheme, libraries: ReadonlySet<ViewLibraryName>): string {
  const importMap = libraries.has("three") ? `<script type="importmap">${scriptJson({ imports: THREE_IMPORTS })}</script>` : ""
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<style>${BASE_CSS}</style>${importMap}<script>(${KIT})(${scriptJson(theme)})</script></head><body>${html}</body></html>`
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
