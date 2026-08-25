/**
 * What a share guest may reach.
 *
 * Default deny. Every rule names its method and derives the session identity
 * from the request, which must equal the share's. Mutations are absent by
 * design: they live under /api/share/*, where the session comes from the token
 * and there is nothing in the request to compare.
 *
 * Matching is deliberately unforgiving about the shape of the request target,
 * because the router downstream is not. Express dispatches on the raw,
 * undecoded, case-insensitive path and strips only the mount prefix, so a
 * traversal resolved here would still be handed to the route named by its raw
 * prefix: `/api/file-content/..%2f..%2fapi%2fhello` resolves to `/api/hello`
 * but is dispatched to the file reader. So nothing is resolved — dot segments,
 * empty segments, backslashes, control characters and encoded separators are
 * rejected outright.
 *
 * Route segments are compared raw, so only their canonical spelling matches;
 * identity segments are compared after one percent-decode, which is exactly
 * what the handlers do with them.
 */

export interface ShareScope {
  sessionId: string
  dirName: string
  fileName: string
}

/** Endpoints under /api/share/ are token-scoped, so the path carries no identity. */
const SHARE_NAMESPACE: ReadonlyArray<readonly [string, string]> = [
  ["GET", "/api/share/session"],
  ["POST", "/api/share/send-message"],
  ["POST", "/api/share/stop"],
  ["POST", "/api/share/interrupt"],
  ["POST", "/api/share/permission"],
  ["POST", "/api/share/answer"],
]

/** True when `value` holds a control character or one of `forbidden`. */
function hasForbiddenChar(value: string, forbidden: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
    if (forbidden.includes(value[i])) return true
  }
  return false
}

interface RequestPath {
  /** Segments as sent, used to match route names. */
  raw: string[]
  /** The same segments after one percent-decode, used to match identities. */
  decoded: string[]
}

function parseRequestPath(rawUrl: string): RequestPath | null {
  const queryStart = rawUrl.search(/[?#]/)
  const path = queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart)
  // Everything reachable lives under a lowercase /api/, so requiring the prefix
  // also rejects absolute and protocol-relative targets and the /API/ casing
  // Express would happily route.
  if (!path.startsWith("/api/")) return null
  // A space or backslash in a target is either malformed or a separator trick.
  if (hasForbiddenChar(path, " \\")) return null

  const raw = path.slice(1).split("/")
  const decoded: string[] = []
  for (const segment of raw) {
    let value: string
    try {
      value = decodeURIComponent(segment)
    } catch {
      return null
    }
    if (value === "" || value === "." || value === "..") return null
    // A surviving "%" would become a separator again for anything that decodes twice.
    if (hasForbiddenChar(value, "/\\%")) return null
    decoded.push(value)
  }
  return { raw, decoded }
}

export function shareRequestAllowed(method: string, rawUrl: string, share: ShareScope): boolean {
  const path = parseRequestPath(rawUrl)
  if (path === null) return false
  const verb = method.toUpperCase()
  const route = path.raw[1]
  const identity = path.decoded.slice(2)

  if (verb === "GET" && route === "hello" && identity.length === 0) return true

  const routePath = `/${path.raw.join("/")}`
  if (SHARE_NAMESPACE.some(([allowedVerb, allowedPath]) =>
    allowedVerb === verb && allowedPath === routePath)) return true

  if (verb === "GET" && (route === "sessions" || route === "watch")) {
    return identity.length === 2
      && identity[0] === share.dirName
      && identity[1] === share.fileName
  }

  if (verb === "GET" && (route === "session-status" || route === "session-file-changes")) {
    return identity.length === 1 && identity[0] === share.sessionId
  }

  if ((verb === "GET" || verb === "PUT") && route === "session-config") {
    return identity.length === 1 && identity[0] === share.fileName
  }

  return false
}
