/** Notifications shared by the server, the renderer and the desktop shell protocol. */

export interface NotificationNav {
  /** Session/thread id, used to deep-link on click. */
  sessionId: string | null
  /** Project dir name: `-Users-me-proj` for Claude, `codex__<b64cwd>` for Codex. */
  dirName: string | null
}

/** What raised a notification: a turn ending, a prompt waiting, the host itself, or its reader given access to a session. */
export type NotificationKind = "turnComplete" | "permission" | "system" | "access"

/** A notification in the active device's inbox, as `/api/notifications` lists it. */
export interface CogpitNotification {
  id: string
  at: string
  title: string
  body: string
  kind: NotificationKind
  sessionId: string | null
  dirName: string | null
  readAt: string | null
}

/** A notification to raise, before any sink decides how to present it. */
export interface NotificationContent {
  title: string
  body: string
  nav: NotificationNav
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
 * *desktop* notification, which the desktop shell decides separately.
 */
export function computeDesktopAttention(
  state: DesktopState,
  idleThresholdSeconds = DESKTOP_IDLE_THRESHOLD_SECONDS,
): boolean {
  if (!state.hasWindow || state.locked) return false
  return state.idleSeconds < idleThresholdSeconds
}

/**
 * SPA path for a session, matching the scheme parsed by useUrlSync:
 * `/{dirName}/{sessionId}`.
 */
export function sessionPath(nav: NotificationNav): string | null {
  if (!nav.dirName || !nav.sessionId) return null
  return `/${encodeURIComponent(nav.dirName)}/${encodeURIComponent(nav.sessionId)}`
}
