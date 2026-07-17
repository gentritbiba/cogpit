import { performance } from "node:perf_hooks"

import type { Middleware, UseFn } from "../helpers"
import {
  createServerPerformanceSnapshot,
  normalizeApiPath,
  recordRequest,
} from "../lib/activityMonitor"

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
  // Register first so all later API handlers are measured.
  use("/api", requestMonitor)

  use("/api/performance", (req, res, next) => {
    if (req.method !== "GET") return next()
    const url = new URL(req.url ?? "/", "http://localhost")
    if (url.pathname !== "/") return next()

    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify(createServerPerformanceSnapshot()))
  })
}
