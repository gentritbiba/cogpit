/**
 * Desktop notification contract shared by the server and the Electron main
 * process.
 *
 * The API server runs in an Electron utilityProcess, where the main-process
 * modules (Notification/BrowserWindow/app) do not exist. So the server only
 * *describes* a notification and posts it over the parent message port; the
 * main process presents it. That indirection is also what attributes the
 * notification to the Cogpit app bundle.
 */

export interface NotificationNav {
  /** Session/thread id, used to deep-link on click. */
  sessionId: string | null
  /** Project dir name: `-Users-me-proj` for Claude, `codex__<b64cwd>` for Codex. */
  dirName: string | null
}

/** A notification to raise, before any sink decides how to present it. */
export interface NotificationContent {
  title: string
  body: string
  nav: NotificationNav
}

export interface NotifyMessage extends NotificationContent {
  type: "notify"
}

/**
 * Whether the user is present at the desktop. Reported by the Electron main
 * process so the server can decide to reach for the phone instead.
 */
export interface DesktopAttentionMessage {
  type: "desktop-attention"
  attended: boolean
}

/** Seconds without input after which we assume the user has walked away. */
export const DESKTOP_IDLE_THRESHOLD_SECONDS = 120

export interface DesktopState {
  hasWindow: boolean
  /** Screen locked, or the machine is suspending. */
  locked: boolean
  /** Seconds since the last keyboard/mouse input anywhere on the machine. */
  idleSeconds: number
}

/**
 * Whether a human is at this computer — deliberately NOT "is Cogpit focused".
 *
 * Focus is the wrong signal in both directions: someone who walks away leaving
 * Cogpit focused would never get a push (the one case push exists for), while
 * someone coding in their editor with Cogpit merely blurred would get one every
 * time. System idle time answers the question actually being asked. Whether
 * Cogpit is showing the session still matters, but only for suppressing the
 * *desktop* notification, which the main process decides separately.
 */
export function computeDesktopAttention(
  state: DesktopState,
  idleThresholdSeconds = DESKTOP_IDLE_THRESHOLD_SECONDS,
): boolean {
  if (!state.hasWindow || state.locked) return false
  return state.idleSeconds < idleThresholdSeconds
}

export function isDesktopAttentionMessage(message: unknown): message is DesktopAttentionMessage {
  if (typeof message !== "object" || message === null) return false
  const candidate = message as Partial<DesktopAttentionMessage>
  return candidate.type === "desktop-attention" && typeof candidate.attended === "boolean"
}

export function isNotifyMessage(message: unknown): message is NotifyMessage {
  if (typeof message !== "object" || message === null) return false
  const candidate = message as Partial<NotifyMessage>
  if (candidate.type !== "notify") return false
  if (typeof candidate.title !== "string" || typeof candidate.body !== "string") return false
  return typeof candidate.nav === "object" && candidate.nav !== null
}

/**
 * SPA path for a session, matching the scheme parsed by useUrlSync:
 * `/{dirName}/{sessionId}`.
 */
export function sessionPath(nav: NotificationNav): string | null {
  if (!nav.dirName || !nav.sessionId) return null
  return `/${encodeURIComponent(nav.dirName)}/${encodeURIComponent(nav.sessionId)}`
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/**
 * True when the window is already showing this session, so a notification for
 * it would be redundant.
 *
 * Codex notifications address a session by bare thread id while the session
 * list navigates to the dated rollout path ending in that same id, so the
 * session segment is matched on suffix as well as equality.
 */
export function isViewingSession(currentUrl: string, nav: NotificationNav): boolean {
  if (!nav.dirName || !nav.sessionId) return false

  let pathname: string
  try {
    pathname = new URL(currentUrl).pathname
  } catch {
    return false
  }

  const segments = pathname.split("/").filter(Boolean)
  // Remote devices are addressed under a /d/{deviceId} prefix.
  if (segments[0] === "d") segments.splice(0, 2)
  if (segments.length < 2) return false

  if (decodeSegment(segments[0]) !== nav.dirName) return false
  const sessionSegment = decodeSegment(segments[1])
  return sessionSegment === nav.sessionId || sessionSegment.endsWith(nav.sessionId)
}
