/**
 * The guest route: `/shared/:sessionId`.
 *
 * Matched exactly. A guest shell renders with no login gate, no config gate and
 * no sidebar, so anything that is not precisely this shape must fall through to
 * the normal app rather than be coerced into a share. That includes a
 * device-prefixed path — shares deliberately do not compose with the hub, whose
 * proxy only forwards `/api/*` anyway.
 */

const SHARE_ROUTE = /^\/shared\/([^/]+)\/?$/

/**
 * The shared session id for `pathname`, or null when it is not a share path.
 *
 * The id is percent-decoded once, matching what the server does with the id it
 * reads back out of the share token.
 */
export function sharedSessionId(pathname: string): string | null {
  const match = SHARE_ROUTE.exec(pathname)
  if (!match) return null
  try {
    return decodeURIComponent(match[1]) || null
  } catch {
    return null
  }
}

export function isSharedPath(pathname: string): boolean {
  return sharedSessionId(pathname) !== null
}
