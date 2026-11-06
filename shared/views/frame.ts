/**
 * What every interactive view's page starts with, whether the renderer
 * composes it from an inline block or the host builds it from a stored view:
 * Cogpit's theme, a base stylesheet so plain markup already looks native, and
 * the in-frame kit that gives the page `window.cogpit`.
 */

export interface ViewTheme {
  mode: "light" | "dark"
  tokens: Record<string, string>
}

export const VIEW_BASE_CSS = `*,*::before,*::after{box-sizing:border-box}
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
export const VIEW_FRAME_KIT = String.raw`(initialTheme) => {
  const host = window.parent
  const root = document.documentElement
  const post = (message) => host.postMessage({ cogpitView: 1, ...message }, "*")
  const located = (error) => {
    const frame = /(?:^|[\s(@])((?!cogpit-kit\/)[\w.\/-]+\.(?:tsx|ts|jsx|js)):(\d+):\d+/.exec(String(error?.stack ?? ""))
    return frame ? " (" + frame[1] + ":" + frame[2] + ")" : ""
  }
  const report = (error) => post({ type: "error", message: String(error?.message ?? error ?? "Unknown error") + located(error) })
  addEventListener("error", (event) => report(event.error ?? event.message))
  addEventListener("unhandledrejection", (event) => report(event.reason))
  let theme = initialTheme && typeof initialTheme === "object" ? initialTheme : { mode: "light", tokens: {} }
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
  applyTheme(theme)
}`

/** A value safe to put inside an inline `<script>`: no `</script>` or comment openers survive. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c")
}

/**
 * Where a host-built page takes the viewer's theme. The host cannot know it,
 * so the client that shows the page swaps it in with {@link withViewTheme}.
 */
export const VIEW_THEME_TOKEN = `"__COGPIT_VIEW_THEME__"`

/** The kit's start-up script, with `theme` or the token a viewer fills in later. */
export function viewKitScript(theme: ViewTheme | null): string {
  return `<script>(${VIEW_FRAME_KIT})(${theme ? scriptJson(theme) : VIEW_THEME_TOKEN})</script>`
}

/** A host-built page with the viewer's theme. The token sits in the head, before anything the agent wrote. */
export function withViewTheme(html: string, theme: ViewTheme): string {
  return html.replace(VIEW_THEME_TOKEN, () => scriptJson(theme))
}
