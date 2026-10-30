import type { IncomingMessage, ServerResponse } from "node:http"
import { AUTOMATION_LIMITS, type SaveAutomationRequest } from "../../shared/contracts/automations"
import { registerAutomationHandler } from "../automations/handler"
import { actOnRun, createTask, deleteTask, ingestDelivery, listRuns, listTasks, rotateSecret, runNow, setTaskState, updateTask, type RunAction } from "../automations/service"
import { editionModule, markDecided } from "../edition"
import { HttpBodyError, readBinaryBody, sendJson, withJsonBody, type UseFn } from "../http"
import { orchestrationStore } from "../orchestration/storage"
import { OrchestrationError } from "../orchestration/store"

/**
 * Scheduled and webhook-triggered tasks (item 8).
 *
 * `/api/automations[/:id[/(pause|resume|run|rotate-secret|runs[/:run/(cancel|reauthorize|mark-started|mark-not-started)])]]`
 * manage the caller's own tasks; every one is scoped to the caller's account,
 * and need host-file and terminal access, since a task picks a host folder and
 * may run worktree setup.
 * `POST /api/automation-hooks/:id` is the webhook ingress: it answers before
 * sign-in and authenticates each delivery by its task's signature instead.
 */

const RUN_ACTIONS = new Set<RunAction>(["cancel", "reauthorize", "mark-started", "mark-not-started"])

function origin(req: IncomingMessage): string {
  const host = req.headers.host ?? "127.0.0.1"
  return `${(req.socket as { encrypted?: boolean }).encrypted ? "https" : "http"}://${host}`
}

function fail(res: ServerResponse, error: unknown): void {
  if (res.headersSent) return
  const status = error instanceof OrchestrationError || error instanceof HttpBodyError ? (error instanceof HttpBodyError ? error.statusCode : error.status) : 500
  sendJson(res, status, { error: error instanceof Error ? error.message : "The request failed" })
}

export function registerAutomationRoutes(use: UseFn) {
  registerAutomationHandler(orchestrationStore)

  use("/api/automation-hooks/", async (req, res, next) => {
    if (req.method !== "POST") return next()
    const id = new URL(req.url || "/", "http://localhost").pathname.split("/").filter(Boolean)
    if (id.length !== 1 || !/^[a-zA-Z0-9_-]{8,128}$/.test(id[0]!)) return next()
    markDecided(req)
    try {
      const body = await readBinaryBody(req, { maxBytes: AUTOMATION_LIMITS.webhookBodyBytes, tooLargeMessage: "Webhook bodies are limited to 64 KB" })
      const result = ingestDelivery(id[0]!, req.headers, body)
      sendJson(res, result.status, result.body)
    } catch (error) { fail(res, error) }
  })

  use("/api/automations", async (req, res, next) => {
    const parts = new URL(req.url || "/", "http://localhost").pathname.split("/").filter(Boolean).map(decodeURIComponent)
    markDecided(req)
    const { capabilities } = editionModule().me(req)
    if (!capabilities.hostFiles || !capabilities.terminal) return sendJson(res, 403, { error: "Host-file and terminal access is required to manage scheduled tasks" })
    const [id, verb, runId, runAction] = parts
    try {
      if (!id) {
        if (req.method === "GET") return sendJson(res, 200, { tasks: listTasks(req, origin(req)) })
        if (req.method !== "POST") return next()
        return withJsonBody<SaveAutomationRequest>(req, res, async (body) => {
          try { sendJson(res, 201, await createTask(req, body.definition, body.state ?? "active", origin(req))) } catch (error) { fail(res, error) }
        })
      }
      if (!verb) {
        if (req.method === "DELETE") { deleteTask(req, id); return sendJson(res, 200, { deleted: true }) }
        if (req.method !== "PUT") return next()
        return withJsonBody<SaveAutomationRequest>(req, res, async (body) => {
          if (typeof body.expectedRevision !== "number") return sendJson(res, 400, { error: "expectedRevision is required" })
          try { sendJson(res, 200, await updateTask(req, id, body.definition, body.state ?? "active", body.expectedRevision, origin(req))) } catch (error) { fail(res, error) }
        })
      }
      if (verb === "runs" && !runId && req.method === "GET") {
        const before = Number(new URL(req.url || "/", "http://localhost").searchParams.get("before")) || undefined
        return sendJson(res, 200, { runs: listRuns(req, id, before) })
      }
      if (req.method !== "POST") return next()
      if (verb === "pause" || verb === "resume") return sendJson(res, 200, { task: setTaskState(req, id, verb === "pause" ? "paused" : "active", origin(req)) })
      if (verb === "run") return sendJson(res, 202, { run: runNow(req, id) })
      if (verb === "rotate-secret") return sendJson(res, 200, { webhookSecret: rotateSecret(req, id) })
      if (verb === "runs" && runId && RUN_ACTIONS.has(runAction as RunAction)) return sendJson(res, 200, { run: await actOnRun(req, id, runId, runAction as RunAction) })
      return next()
    } catch (error) { fail(res, error) }
  })
}
