/**
 * Workflow visualization routes.
 *
 * Workflows are per-session: their journals live under a session's directory,
 * so every endpoint is scoped by (dirName, sessionId). The feature is
 * view-only plus a best-effort force-stop:
 *
 *   GET  /api/workflows/:dirName/:sessionId            list workflows
 *   GET  /api/workflow-detail/:dirName/:sessionId/:runId   full run detail
 *   GET  /api/workflow-watch/:dirName/:sessionId[/:runId]  SSE live updates
 *   POST /api/workflow-stop                            force-stop a run
 *
 * Mirrors the team-watch SSE pattern (debounced fs.watch → {type:"update"}).
 */
import { watch, activeProcesses, persistentSessions } from "../helpers"
import type { UseFn } from "../http"
import { sdkSessions, stopSDKSession } from "../sdk-session"
import {
  listSessionWorkflows,
  readWorkflowDetail,
  workflowsDirFor,
  sessionDirFor,
} from "../lib/workflows"

function sendJson(res: { setHeader: (k: string, v: string) => void; end: (s: string) => void }, body: unknown): void {
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify(body))
}

/** Is the owning session a live, Cogpit-managed process we can stop? */
function isControllable(sessionId: string): boolean {
  return (
    sdkSessions.has(sessionId) ||
    persistentSessions.has(sessionId) ||
    activeProcesses.has(sessionId)
  )
}

/** Force-stop the session that owns a workflow. Returns true if anything was stopped. */
function stopOwningSession(sessionId: string): boolean {
  let stopped = stopSDKSession(sessionId)

  const ps = persistentSessions.get(sessionId)
  if (ps && !ps.dead) {
    ps.dead = true
    try { ps.proc.kill("SIGTERM") } catch { /* already dead */ }
    persistentSessions.delete(sessionId)
    const force = setTimeout(() => {
      try { ps.proc.kill("SIGKILL") } catch { /* already dead */ }
    }, 3000)
    force.unref()
    stopped = true
  }

  const child = activeProcesses.get(sessionId)
  if (child) {
    try { child.kill("SIGTERM") } catch { /* already dead */ }
    const force = setTimeout(() => {
      if (activeProcesses.has(sessionId)) {
        try { child.kill("SIGKILL") } catch { /* already dead */ }
      }
    }, 3000)
    force.unref()
    stopped = true
  }

  return stopped
}

export function registerWorkflowRoutes(use: UseFn) {
  // GET /api/workflows/:dirName/:sessionId — list workflows for a session
  use("/api/workflows/", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const parts = url.pathname.split("/").filter(Boolean)
    if (parts.length !== 2) return next()

    const dirName = decodeURIComponent(parts[0])
    const sessionId = decodeURIComponent(parts[1])

    if (!workflowsDirFor(dirName, sessionId)) {
      res.statusCode = 403
      res.end(JSON.stringify({ error: "Access denied" }))
      return
    }

    try {
      const workflows = await listSessionWorkflows(dirName, sessionId)
      sendJson(res, workflows)
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: String(err) }))
    }
  })

  // GET /api/workflow-detail/:dirName/:sessionId/:runId — full run detail
  use("/api/workflow-detail/", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const parts = url.pathname.split("/").filter(Boolean)
    if (parts.length !== 3) return next()

    const dirName = decodeURIComponent(parts[0])
    const sessionId = decodeURIComponent(parts[1])
    const runId = decodeURIComponent(parts[2])

    if (!workflowsDirFor(dirName, sessionId)) {
      res.statusCode = 403
      res.end(JSON.stringify({ error: "Access denied" }))
      return
    }

    try {
      const detail = await readWorkflowDetail(dirName, sessionId, runId)
      if (!detail) {
        res.statusCode = 404
        res.end(JSON.stringify({ error: "Workflow not found" }))
        return
      }
      sendJson(res, { ...detail, controllable: isControllable(sessionId) })
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: String(err) }))
    }
  })

  // GET /api/workflow-watch/:dirName/:sessionId[/:runId] — SSE live updates
  use("/api/workflow-watch/", (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const parts = url.pathname.split("/").filter(Boolean)
    if (parts.length !== 2 && parts.length !== 3) return next()

    const dirName = decodeURIComponent(parts[0])
    const sessionId = decodeURIComponent(parts[1])
    const runId = parts.length === 3 ? decodeURIComponent(parts[2]) : null

    const sessionDir = sessionDirFor(dirName, sessionId)
    const workflowsDir = workflowsDirFor(dirName, sessionId)
    if (!sessionDir || !workflowsDir) {
      res.statusCode = 403
      res.end(JSON.stringify({ error: "Access denied" }))
      return
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    })

    let closed = false
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    const sendUpdate = () => {
      if (closed) return
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        if (!closed) res.write(`data: ${JSON.stringify({ type: "update" })}\n\n`)
      }, 400)
    }

    // Only react to workflow-related file churn (ignore other subagent noise).
    const onChange = (_event: string, filename: string | Buffer | null) => {
      const name = filename ? filename.toString() : ""
      if (runId) {
        if (name.includes(runId)) sendUpdate()
      } else if (name.includes("workflow")) {
        sendUpdate()
      }
    }

    const watchers: ReturnType<typeof watch>[] = []
    // Watch the whole session dir recursively: catches creation of the
    // workflows/ dir, journal rewrites, and per-agent transcript activity.
    try {
      const w = watch(sessionDir, { recursive: true }, onChange)
      w.on("error", () => {})
      watchers.push(w)
    } catch { /* dir may not exist yet */ }

    res.write(`data: ${JSON.stringify({ type: "init" })}\n\n`)

    const heartbeat = setInterval(() => {
      if (!closed) res.write(": heartbeat\n\n")
    }, 15000)

    req.on("close", () => {
      closed = true
      for (const w of watchers) {
        try { w.close() } catch { /* already closed */ }
      }
      if (debounceTimer) clearTimeout(debounceTimer)
      clearInterval(heartbeat)
    })
  })

  // POST /api/workflow-stop — force-stop the session owning a workflow run
  use("/api/workflow-stop", (req, res, next) => {
    if (req.method !== "POST") return next()

    let body = ""
    req.on("data", (chunk: string) => { body += chunk })
    req.on("end", () => {
      let parsed: { sessionId?: string; runId?: string }
      try {
        parsed = JSON.parse(body)
      } catch {
        res.statusCode = 400
        res.end(JSON.stringify({ error: "Invalid JSON body" }))
        return
      }

      const sessionId = parsed.sessionId
      if (!sessionId || typeof sessionId !== "string") {
        res.statusCode = 400
        res.end(JSON.stringify({ error: "sessionId is required" }))
        return
      }

      if (!isControllable(sessionId)) {
        sendJson(res, {
          success: false,
          controllable: false,
          error: "This workflow runs in a session Cogpit doesn't control.",
        })
        return
      }

      const stopped = stopOwningSession(sessionId)
      sendJson(res, { success: stopped, controllable: true })
    })
  })
}
