/**
 * Workflow visualization routes.
 *
 * Workflows are per-session: their journals live under a session's directory,
 * so every endpoint is scoped by (dirName, sessionId). The feature is
 * view-only plus a best-effort force-stop:
 *
 *   GET  /api/workflows/:dirName/:sessionId            list workflows
 *   GET  /api/workflow-detail/:dirName/:sessionId/:runId   full run detail
 *   GET  /api/workflow-result/:dirName/:sessionId/:runId   synthesized result
 *   GET  /api/workflow-agent-result/:dirName/:sessionId/:runId/:agentId
 *   GET  /api/workflow-watch/:dirName/:sessionId[/:runId]  SSE live updates
 *   POST /api/workflow-stop                            force-stop a run
 *
 * Mirrors the team-watch SSE pattern (debounced fs.watch → {type:"update"}).
 */
import type { IncomingMessage, ServerResponse } from "node:http"
import { soleDescriptorWhere } from "../../shared/session/agent-descriptors"
import { authorizeSession, reportSessionEvent } from "../edition"
import { watch, activeProcesses, persistentSessions } from "../helpers"
import { sendJson, withJsonBody, type UseFn } from "../http"
import { sdkSessions, stopSDKSession } from "../sdk-session"
import {
  isSafeRunId,
  listSessionWorkflows,
  readWorkflowAgentResult,
  readWorkflowDetail,
  readWorkflowResult,
  workflowsDirFor,
  sessionDirFor,
} from "../lib/workflows"

const WORKFLOW_AGENT = soleDescriptorWhere((descriptor) => descriptor.capabilities.workflows, "workflows").kind

/** The decoded path segments after the mount, or null when there are not `counts` of them. */
function pathSegments(req: IncomingMessage, ...counts: number[]): string[] | null {
  const parts = new URL(req.url || "/", "http://localhost").pathname.split("/").filter(Boolean)
  return counts.includes(parts.length) ? parts.map(decodeURIComponent) : null
}

/**
 * The session whose workflows a request reads, once its journals lie inside
 * PROJECTS_DIR and the caller may view it; null after answering.
 */
async function authorizeWorkflows(
  req: IncomingMessage,
  res: ServerResponse,
  dirName: string,
  sessionId: string,
): Promise<string | null> {
  if (!workflowsDirFor(dirName, sessionId)) {
    sendJson(res, 403, { error: "Access denied" })
    return null
  }
  return (await authorizeSession(req, res, { sessionId }, "view"))?.sessionId ?? null
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
    const parts = pathSegments(req, 2)
    if (!parts) return next()
    const [dirName] = parts
    const sessionId = await authorizeWorkflows(req, res, dirName, parts[1])
    if (!sessionId) return

    try {
      const workflows = await listSessionWorkflows(dirName, sessionId)
      sendJson(res, 200, workflows)
    } catch (err) {
      sendJson(res, 500, { error: String(err) })
    }
  })

  // GET /api/workflow-detail/:dirName/:sessionId/:runId — full run detail
  use("/api/workflow-detail/", async (req, res, next) => {
    if (req.method !== "GET") return next()
    const parts = pathSegments(req, 3)
    if (!parts) return next()
    const [dirName, , runId] = parts
    const sessionId = await authorizeWorkflows(req, res, dirName, parts[1])
    if (!sessionId) return

    try {
      const detail = await readWorkflowDetail(dirName, sessionId, runId)
      if (!detail) {
        sendJson(res, 404, { error: "Workflow not found" })
        return
      }
      sendJson(res, 200, { ...detail, controllable: isControllable(sessionId) })
    } catch (err) {
      sendJson(res, 500, { error: String(err) })
    }
  })

  // GET /api/workflow-result/:dirName/:sessionId/:runId
  use("/api/workflow-result/", async (req, res, next) => {
    if (req.method !== "GET") return next()
    const parts = pathSegments(req, 3)
    if (!parts) return next()
    const [dirName, , runId] = parts
    const sessionId = await authorizeWorkflows(req, res, dirName, parts[1])
    if (!sessionId) return

    try {
      const result = await readWorkflowResult(dirName, sessionId, runId)
      if (!result) {
        sendJson(res, 404, { error: "Workflow result not found" })
        return
      }
      sendJson(res, 200, result)
    } catch (err) {
      sendJson(res, 500, { error: String(err) })
    }
  })

  // GET /api/workflow-agent-result/:dirName/:sessionId/:runId/:agentId
  use("/api/workflow-agent-result/", async (req, res, next) => {
    if (req.method !== "GET") return next()
    const parts = pathSegments(req, 4)
    if (!parts) return next()
    const [dirName, , runId, agentId] = parts
    const sessionId = await authorizeWorkflows(req, res, dirName, parts[1])
    if (!sessionId) return

    try {
      const agentResult = await readWorkflowAgentResult(dirName, sessionId, runId, agentId)
      if (!agentResult) {
        sendJson(res, 404, { error: "Agent result not found" })
        return
      }
      sendJson(res, 200, agentResult)
    } catch (err) {
      sendJson(res, 500, { error: String(err) })
    }
  })

  // GET /api/workflow-watch/:dirName/:sessionId[/:runId] — SSE live updates
  use("/api/workflow-watch/", async (req, res, next) => {
    if (req.method !== "GET") return next()
    const parts = pathSegments(req, 2, 3)
    if (!parts) return next()
    const [dirName, , runId = null] = parts
    const sessionId = await authorizeWorkflows(req, res, dirName, parts[1])
    if (!sessionId) return
    // authorizeWorkflows found the session's workflows inside PROJECTS_DIR, so its directory is too.
    const sessionDir = sessionDirFor(dirName, sessionId)!
    // The caller may have gone, or lost its login, while access was checked.
    if (res.destroyed || res.writableEnded) return

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

    withJsonBody<{ sessionId?: string; runId?: string }>(req, res, async (parsed) => {
      if (!parsed.sessionId || typeof parsed.sessionId !== "string") {
        sendJson(res, 400, { error: "sessionId is required" })
        return
      }
      const session = await authorizeSession(req, res, { sessionId: parsed.sessionId }, "interact")
      if (!session) return
      const { sessionId } = session

      if (!isControllable(sessionId)) {
        sendJson(res, 200, {
          success: false,
          controllable: false,
          error: "This workflow runs in a session Cogpit doesn't control.",
        })
        return
      }

      const stopped = stopOwningSession(sessionId)
      if (stopped) {
        const runId = typeof parsed.runId === "string" && isSafeRunId(parsed.runId) ? { runId: parsed.runId } : undefined
        reportSessionEvent(req, "session.stop", { sessionId, agent: WORKFLOW_AGENT }, runId)
      }
      sendJson(res, 200, { success: stopped, controllable: true })
    })
  })
}
