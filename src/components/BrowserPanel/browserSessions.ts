import { DEFAULT_BROWSER } from "../../../shared/browser/names"
import type { BrowserControl, BrowserSessionInfo } from "../../../shared/browser/types"

export { DEFAULT_BROWSER }

/**
 * The browser the panel falls back to: the caller's own when the server gives
 * them one, else the host's `default`.
 */
export function homeBrowser(sessions: readonly BrowserSessionInfo[]): string {
  return sessions.find((session) => session.mine)?.name ?? DEFAULT_BROWSER
}

/** An older server says nothing, and lets every caller own every browser. */
export function controlOf(session: BrowserSessionInfo | null | undefined): BrowserControl {
  return session?.control ?? "own"
}

/** Whether the caller may use the page, not only watch it. */
export function canDrive(session: BrowserSessionInfo | null | undefined): boolean {
  return controlOf(session) !== "watch"
}

/** How a browser reads in the panel: an account's own by whose it is, anything else by name. */
export function browserLabel(session: BrowserSessionInfo | null | undefined, name: string): string {
  if (session?.mine) return "Your browser"
  if (session?.account) return `${session.account}'s browser`
  return name
}

/**
 * The browser an agent's `agent-browser` call named. A call that named none
 * went to `default`, which a server that gives each account its own profile
 * sent to the session owner's: the one this session drove last.
 */
export function drivenBrowser(
  named: string | null,
  sessions: readonly BrowserSessionInfo[],
  sessionId: string | null,
): string | null {
  if (named !== DEFAULT_BROWSER || sessionId === null) return named
  const owned = sessions.find((session) => (session.mine || session.account) && session.driverSessionId === sessionId)
  return owned?.name ?? named
}
