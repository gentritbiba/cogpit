import { authorizeSession } from "../edition"
import { sendJson, withJsonBody, type UseFn } from "../http"
import { orchestrationStore } from "../orchestration/storage"
import { acknowledgeTask, cancelTask } from "../orchestration/delegatedTasks"
import { commandScope } from "../lib/durableSend"
import { delegationAuthority, resumeDelegations } from "../lib/delegationAuthority"
import { sendAgentError } from "./agentErrors"
export function registerDelegatedTaskRoutes(use: UseFn): void {
  use("/api/delegated-tasks", async (req, res, next) => {
    if (req.method === "GET") {
      try {
        const parentSessionId = new URL(req.url || "/", "http://localhost").searchParams.get("sessionId")
        if (!parentSessionId) return sendJson(res, 400, { error: "sessionId is required" })
        if (await authorizeSession(req, res, { sessionId: parentSessionId }, "view") === null) return
        const authority = delegationAuthority(req, "view")
        const tasks = []
        for (const task of orchestrationStore().tasks(commandScope(req), parentSessionId)) if (await authority.authorize(task.childSessionId)) tasks.push(task)
        resumeDelegations(req, parentSessionId)
        sendJson(res, 200, { tasks })
      } catch (error) { sendAgentError(res, error, "Failed to read delegated tasks") }
      return
    }
    if (req.method !== "POST") return next()
    withJsonBody<{ sessionId?: string; taskId?: string; action?: string }>(req, res, async (body) => {
      try {
        if (!body.sessionId || !body.taskId) return sendJson(res, 400, { error: "sessionId and taskId are required" })
        if (await authorizeSession(req, res, { sessionId: body.sessionId }, "interact") === null) return
        const scope = commandScope(req)
        const stored = orchestrationStore().tasks(scope, body.sessionId).find((task) => task.id === body.taskId)
        if (!stored) return sendJson(res, 404, { error: "Delegated task not found" })
        if (await authorizeSession(req, res, { sessionId: stored.childSessionId }, "interact") === null) return
        const task = body.action === "ack" ? acknowledgeTask(scope, body.sessionId, body.taskId) : body.action === "cancel" ? await cancelTask(scope, body.sessionId, body.taskId, delegationAuthority(req)) : null
        if (!task) return sendJson(res, 400, { error: "Choose ack or cancel" })
        sendJson(res, 200, { task })
      } catch (error) { sendAgentError(res, error, "Failed to update delegated task") }
    })
  })
}
