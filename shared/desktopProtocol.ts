/**
 * The line-delimited JSON protocol between the desktop shell (`desktop/`, Rust)
 * and the API server it runs as a sidecar process.
 *
 * The server writes {@link ServerMessage} lines to its stdout and reads
 * {@link ShellMessage} lines from its stdin. Logs go to stderr, so stdout
 * carries nothing else. The shell closing stdin means it is gone, and the
 * server shuts down as it would for a `shutdown` message.
 */
import type { DesktopState, NotificationContent } from "./notifications"

/** The server is listening; the shell points its window at this port. */
export interface ReadyMessage {
  type: "ready"
  port: number
}

/** The server could not start; `error` is shown in the startup error dialog. */
export interface StartupErrorMessage {
  type: "error"
  error: string
}

/**
 * A desktop notification for the shell to present. The server only describes
 * it: the shell owns the native notification API, which is what attributes the
 * notification to the Cogpit app and makes it clickable.
 */
export interface NotifyMessage extends NotificationContent {
  type: "notify"
  /** History entry id, echoed back on click so the entry can be marked read. */
  historyId?: string
  /** SPA path a click reveals, or null when the notification is not about one session. */
  path: string | null
}

export type ServerMessage = ReadyMessage | StartupErrorMessage | NotifyMessage

/**
 * What the shell can see of the user's presence, sampled on window and power
 * events and on a slow timer. The server decides from it whether the user is
 * at the desktop or should be reached on the phone.
 */
export interface DesktopPresenceMessage extends DesktopState {
  type: "desktop-presence"
}

/** The user clicked the notification for this history entry. */
export interface NotificationClickedMessage {
  type: "notification-clicked"
  historyId: string
}

/** The app is quitting: save what needs saving and exit. */
export interface ShutdownMessage {
  type: "shutdown"
}

export type ShellMessage = DesktopPresenceMessage | NotificationClickedMessage | ShutdownMessage

export function encodeServerMessage(message: ServerMessage): string {
  return `${JSON.stringify(message)}\n`
}

/** One stdin line from the shell, or null when it is not a message this server understands. */
export function parseShellMessage(line: string): ShellMessage | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof value !== "object" || value === null) return null
  const message = value as Record<string, unknown>
  switch (message.type) {
    case "desktop-presence":
      return typeof message.hasWindow === "boolean"
        && typeof message.locked === "boolean"
        && typeof message.idleSeconds === "number"
        ? { type: "desktop-presence", hasWindow: message.hasWindow, locked: message.locked, idleSeconds: message.idleSeconds }
        : null
    case "notification-clicked":
      return typeof message.historyId === "string"
        ? { type: "notification-clicked", historyId: message.historyId }
        : null
    case "shutdown":
      return { type: "shutdown" }
    default:
      return null
  }
}
