import { createHash } from "node:crypto"

export const PLUGIN_SHELL_PATH = "/api/plugins/shell/v1"

const script = String.raw`(() => {
  let connected = false
  window.addEventListener("message", (event) => {
    if (connected || window.parent === window || event.source !== window.parent || event.data?.type !== "cogpit-plugin-connect"
      || typeof event.data.nonce !== "string" || !/^[a-f0-9]{64}$/.test(event.data.nonce) || event.ports.length !== 1) return
    connected = true
    const port = event.ports[0]
    const urls = []
    let loaded = false
    const report = () => port.postMessage({ type: "cogpit-plugin-load-error" })
    let previousTokens = []
    const applyTheme = (theme) => {
      document.documentElement.style.colorScheme = theme.mode
      document.documentElement.classList.toggle("dark", theme.mode === "dark")
      document.documentElement.classList.toggle("theme-layered", Boolean(theme.tokens["--surface"]))
      for (const key of previousTokens) document.documentElement.style.removeProperty(key)
      previousTokens = Object.keys(theme.tokens)
      for (const [key, value] of Object.entries(theme.tokens)) document.documentElement.style.setProperty(key, String(value))
    }
    const applyContext = (context) => {
      document.documentElement.lang = context.locale
      document.documentElement.dataset.reducedMotion = String(context.reducedMotion)
      applyTheme(context.theme)
    }
    window.addEventListener("error", report)
    window.addEventListener("unhandledrejection", report)
    window.addEventListener("pagehide", () => { for (const url of urls) URL.revokeObjectURL(url); port.close() }, { once: true })
    const load = (message) => {
      if (loaded || message.data?.type !== "cogpit-plugin-load") return
      loaded = true
      port.removeEventListener("message", load)
      const input = message.data
      try {
        const assets = Object.create(null)
        for (const asset of input.assets) {
          const url = URL.createObjectURL(new Blob([asset.bytes], { type: asset.mime }))
          assets[asset.path] = url
          urls.push(url)
        }
        if (input.style !== null) {
          const style = document.createElement("style")
          style.textContent = input.style.replace(/url\("([^"]+)"\)/g, (_match, path) => {
            if (!Object.hasOwn(assets, path)) throw new Error("Unknown package asset")
            return 'url("' + assets[path] + '")'
          })
          document.head.append(style)
        }
        applyContext(input.context)
        port.addEventListener("message", (event) => {
          const message = event.data
          if (message?.protocol !== 1 || message.type !== "event") return
          if (message.event === "theme") applyTheme(message.value)
          if (message.event === "context") applyContext(message.value)
        })
        const script = document.createElement("script")
        const entryUrl = URL.createObjectURL(new Blob([input.entry], { type: "text/javascript" }))
        urls.push(entryUrl)
        script.src = entryUrl
        script.onerror = report
        script.onload = () => {
          URL.revokeObjectURL(entryUrl)
          const entry = globalThis.cogpitPlugin
          if (typeof entry !== "function") { report(); return }
          try { Promise.resolve(entry({ port, context: input.context, assets: Object.freeze(assets) })).catch(report) }
          catch { report() }
        }
        document.body.append(script)
      } catch { report() }
    }
    port.addEventListener("message", load)
    port.start()
    port.postMessage({ type: "cogpit-plugin-connected", nonce: event.data.nonce })
  })
})()`
const hash = createHash("sha256").update(script).digest("base64")
export const PLUGIN_SHELL_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cogpit plugin</title><style>html,body{height:100%;margin:0}body{background:var(--canvas,var(--background));color:var(--foreground)}[data-reduced-motion="true"] *,[data-reduced-motion="true"] *::before,[data-reduced-motion="true"] *::after{animation-duration:1ms!important;animation-iteration-count:1!important;transition-duration:1ms!important;scroll-behavior:auto!important}</style></head><body><script>${script}</script></body></html>`
export const PLUGIN_SHELL_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": `default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; form-action 'none'; script-src 'sha256-${hash}' blob:; style-src 'unsafe-inline'; img-src blob:; font-src 'none'; connect-src 'none'; frame-src 'none'; worker-src 'none'; sandbox allow-scripts`,
  "X-Frame-Options": "SAMEORIGIN",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
})
