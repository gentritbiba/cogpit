/**
 * The document an agent's interactive view runs in. Framed with
 * `sandbox="allow-scripts"`, it has an opaque origin: it cannot read Cogpit's
 * storage or call its API, and its policy allows no network. The parent posts
 * the composed view and the libraries it uses once; the bridge turns each
 * library into a blob URL and replaces itself with the view.
 */
const bridge = String.raw`(() => {
  if (window.parent === window) return
  let rendered = false
  window.addEventListener("message", (event) => {
    const data = event.data
    if (rendered || event.source !== window.parent || data?.type !== "cogpit-view:render"
      || typeof data.html !== "string" || !Array.isArray(data.libraries)) return
    rendered = true
    const urls = Object.create(null)
    for (const library of data.libraries) {
      if (typeof library?.name !== "string" || typeof library.code !== "string") continue
      urls[library.name] = URL.createObjectURL(new Blob([library.code], { type: "text/javascript" }))
    }
    document.open()
    document.write(data.html.replace(/cogpit:lib\/([a-z0-9-]+)/g, (token, name) => urls[name] ?? token))
    document.close()
  })
  window.parent.postMessage({ cogpitView: 1, type: "ready" }, "*")
})()`

export const VIEW_SHELL_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Cogpit view</title></head><body><script>${bridge}</script></body></html>`

export const VIEW_SHELL_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; form-action 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline' blob:; img-src data: blob:; media-src data: blob:; font-src data:; connect-src blob: data:; worker-src blob:; frame-src 'none'; sandbox allow-scripts",
  "X-Frame-Options": "SAMEORIGIN",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), serial=(), hid=()",
})
