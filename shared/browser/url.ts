// Browser-safe: the one place a url the client asked for becomes a url Cogpit
// will open. Every path that reaches a real Chromium — the viewer's `navigate`,
// the daemon `launch` behind the socket and the REST route — goes through it,
// so `file:`, `chrome:`, `javascript:` and friends cannot be opened remotely.

const ALLOWED_SCHEMES = new Set(["http", "https", "about"])
/** A scheme, except that `host:port` is not one. */
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):(?!\d+(?:[/?#]|$))/i
/** Loopback only: a bare `host:port` elsewhere is still https. */
const LOOPBACK_RE = /^(localhost|127(\.\d+){1,3}|0\.0\.0\.0|\[::1\]|::1)(?:[:/?#]|$)/i

export function resolveNavigationUrl(raw: string): string {
  const url = raw.trim()
  if (url === "") throw new Error("Nothing to navigate to")
  const scheme = SCHEME_RE.exec(url)?.[1].toLowerCase()
  if (scheme !== undefined) {
    if (!ALLOWED_SCHEMES.has(scheme)) throw new Error(`Refusing to navigate to a ${scheme}: url`)
    return url
  }
  return `${LOOPBACK_RE.test(url) ? "http" : "https"}://${url}`
}
