/** The part of Electron's UtilityProcess that startup listens to. */
export interface StartingWorker {
  on(event: "message", listener: (message: unknown) => void): unknown
  on(event: "exit", listener: (code: number) => void): unknown
}

export const SERVER_START_TIMEOUT_MS = 15_000

/**
 * The port the server worker reports once it is listening. Rejects with a
 * plain reason when it reports an error, stops early, or takes too long.
 */
export function waitForServerReady(worker: StartingWorker, timeoutMs = SERVER_START_TIMEOUT_MS): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (finish: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      finish()
    }
    const fail = (reason: string) => settle(() => reject(new Error(reason)))
    const timer = setTimeout(() => fail(`The server did not start within ${Math.round(timeoutMs / 1000)} seconds.`), timeoutMs)

    worker.on("message", (message) => {
      if (typeof message !== "object" || message === null) return
      const { type, port, error } = message as { type?: unknown; port?: unknown; error?: unknown }
      if (type === "ready" && typeof port === "number" && port > 0) settle(() => resolve(port))
      else if (type === "error") fail(typeof error === "string" && error ? error : "The server failed to start.")
    })
    worker.on("exit", (code) => fail(`The server stopped before it was ready (exit code ${code}).`))
  })
}

/** The body of the "Cogpit could not start" dialog. */
export function startupFailureMessage(error: unknown, logPath: string | null): string {
  const reason = error instanceof Error ? error.message : String(error)
  return logPath ? `${reason}\n\nThe startup log has the details:\n${logPath}` : reason
}
