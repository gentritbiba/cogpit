import type { IncomingMessage, ServerResponse } from "node:http"

/**
 * Every HTTP response not yet closed. `server.close()` waits for all of them,
 * and an event stream never ends on its own, so shutdown ends what is left.
 */
export interface OpenResponses {
  track(req: IncomingMessage, res: ServerResponse, next: () => void): void
  /** End each open response: a clean end once its headers went out, else drop its connection. */
  endAll(): void
}

export function openResponses(): OpenResponses {
  const open = new Set<ServerResponse>()
  return {
    track(_req, res, next) {
      open.add(res)
      res.once("close", () => open.delete(res))
      next()
    },
    endAll() {
      for (const res of open) {
        // A stream's own timer may still write before its close handler runs; that write is dropped.
        res.on("error", () => {})
        if (res.headersSent) res.end()
        else res.destroy()
      }
      open.clear()
    },
  }
}
