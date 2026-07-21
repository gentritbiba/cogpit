import { performance } from "node:perf_hooks"

import { sendJson, type Middleware, type UseFn } from "../http"
import {
  createServerPerformanceSnapshot,
  normalizeApiPath,
  recordRequest,
} from "../lib/activityMonitor"
import { captureSystemProcesses } from "../lib/systemProcesses"
import { getRecentlyReaped, killPids, startLeakReaper } from "../lib/leakReaper"

const requestMonitor: Middleware = (req, res, next) => {
  const label = normalizeApiPath(req.url ?? "/", req.method)
  if (label === "GET /api/performance") {
    next()
    return
  }

  const started = performance.now()
  let recorded = false
  const finish = () => {
    if (recorded) return
    recorded = true
    recordRequest(label, performance.now() - started)
  }
  res.once("finish", finish)
  res.once("close", finish)
  next()
}

export function registerPerformanceRoutes(use: UseFn): void {
  startLeakReaper()

  // Register first so all later API handlers are measured.
  use("/api", requestMonitor)

  use("/api/system-processes", (req, res, next) => {
    const url = new URL(req.url ?? "/", "http://localhost")

    if (req.method === "GET" && url.pathname === "/") {
      void (async () => {
        try {
          const snapshot = await captureSystemProcesses()
          sendJson(res, 200, { ...snapshot, recentlyReaped: getRecentlyReaped() })
        } catch {
          sendJson(res, 500, { error: "Process listing failed" })
        }
      })()
      return
    }

    if (req.method === "POST" && url.pathname === "/kill") {
      let body = ""
      req.on("data", (chunk: string) => {
        body += chunk
      })
      req.on("end", () => {
        void (async () => {
          let requested: number[]
          try {
            const parsed = JSON.parse(body)
            if (!Array.isArray(parsed.pids) || !parsed.pids.every((pid: unknown) => typeof pid === "number")) {
              return sendJson(res, 400, { error: "Expected { pids: number[] }" })
            }
            requested = parsed.pids
          } catch {
            return sendJson(res, 400, { error: "Invalid JSON body" })
          }

          try {
            // Only pids the current scan flags as suspected leaks may be
            // killed — the client's list is a request, not an authority.
            // This can never target Cogpit itself or a live session.
            const snapshot = await captureSystemProcesses()
            const suspects = new Set(
              (snapshot?.processes ?? [])
                .filter((metric) => metric.suspectedLeak)
                .map((metric) => metric.pid),
            )
            const targets = requested.filter((pid) => suspects.has(pid))
            const killed = killPids(targets)
            sendJson(res, 200, {
              killed,
              skipped: requested.filter((pid) => !killed.includes(pid)),
            })
          } catch {
            sendJson(res, 500, { error: "Kill failed" })
          }
        })()
      })
      return
    }

    next()
  })

  use("/api/performance", (req, res, next) => {
    if (req.method !== "GET") return next()
    const url = new URL(req.url ?? "/", "http://localhost")
    if (url.pathname !== "/") return next()

    void (async () => {
      const snapshot = createServerPerformanceSnapshot()
      try {
        snapshot.system = await captureSystemProcesses()
      } catch {
        // System-wide process listing is best-effort; the core snapshot still ships.
      }
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify(snapshot))
    })()
  })
}
