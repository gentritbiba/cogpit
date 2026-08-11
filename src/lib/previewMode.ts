const PREVIEW_PATH = /^\/preview\/([^/]+)\/?$/

/** Return the session ID carried by a local Cogpit Preview URL. */
export function previewSessionIdFromPath(pathname: string): string | null {
  const match = PREVIEW_PATH.exec(pathname)
  if (!match) return null

  try {
    const sessionId = decodeURIComponent(match[1])
    return sessionId.length > 0 ? sessionId : null
  } catch {
    return null
  }
}
