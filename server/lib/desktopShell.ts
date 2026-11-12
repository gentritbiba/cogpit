import { createInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"
import {
  encodeServerMessage,
  parseShellMessage,
  type ServerMessage,
  type ShellMessage,
} from "../../shared/desktopProtocol"

/**
 * The server's end of the desktop shell protocol (`shared/desktopProtocol.ts`).
 * Connected only when the server runs as the desktop app's sidecar; the
 * standalone server and tests never connect it.
 */
let output: Writable | null = null

export interface DesktopShellHandlers {
  onMessage(message: Exclude<ShellMessage, { type: "shutdown" }>): void
  /** A `shutdown` message, or stdin closing because the shell is gone. Called once. */
  onShutdown(): void
}

export function connectDesktopShell(input: Readable, out: Writable, handlers: DesktopShellHandlers): void {
  output = out
  let shuttingDown = false
  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    handlers.onShutdown()
  }
  const lines = createInterface({ input, crlfDelay: Infinity })
  lines.on("line", (line) => {
    const message = parseShellMessage(line)
    if (!message) {
      if (line.trim()) console.error("[desktop-shell] Ignoring an unknown message:", line)
      return
    }
    if (message.type === "shutdown") shutdown()
    else handlers.onMessage(message)
  })
  lines.on("close", shutdown)
}

/** False when no desktop shell is connected, so the caller can use its own fallback. */
export function postToDesktopShell(message: ServerMessage): boolean {
  if (!output) return false
  output.write(encodeServerMessage(message))
  return true
}

export function disconnectDesktopShellForTest(): void {
  output = null
}
