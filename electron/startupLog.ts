import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export interface StartupLog {
  /** Null when the file could not be created. */
  readonly path: string | null
  write(chunk: Buffer | string): void
  close(): void
}

/**
 * The server worker's output until it is ready, on disk so a failed launch can
 * point at it: a GUI app's own stdout goes nowhere. Written synchronously
 * because the error dialog blocks the event loop before an async write lands.
 * Each launch starts a fresh file. `logsDir` is looked up here because asking
 * Electron for its logs folder can itself throw.
 */
export function openStartupLog(logsDir: () => string): StartupLog {
  let path: string
  let fd: number | null
  try {
    const dir = logsDir()
    path = join(dir, "startup.log")
    mkdirSync(dir, { recursive: true })
    fd = openSync(path, "w")
  } catch {
    // Startup goes on without a log; the error dialog then gives just the reason.
    return { path: null, write() {}, close() {} }
  }
  return {
    path,
    write(chunk) {
      if (fd === null) return
      try {
        writeFileSync(fd, chunk)
      } catch {
        // A full disk must not take startup down with it.
      }
    },
    close() {
      if (fd === null) return
      closeSync(fd)
      fd = null
    },
  }
}
