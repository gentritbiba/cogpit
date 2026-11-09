import { authorizeSession } from "../edition"
import { sendJson, withJsonBody, type UseFn } from "../http"
import { orchestrationStore } from "../orchestration/storage"
import { acknowledgeTask, cancelTask } from "../orchestration/delegatedTasks"
import { commandScope } from "../lib/durableSend"
import { delegationAuthority, resumeDelegations } from "../lib/delegationAuthority"
import { sendJsonWithEtag } from "../lib/jsonEtag"
import { countDelegatedTasks, isUnreadTask, type DelegatedTask } from "../../shared/contracts/orchestration"
import { sendAgentError } from "./agentErrors"

/** The tasks whose child the caller may see, asking once per child. */
async function visible<T extends Pick<DelegatedTask, "childSessionId">>(tasks: readonly T[], authorize: (sessionId: string) => Promise<boolean>): Promise<T[]> {
  const allowed = new Map<string, Promise<boolean>>()
  const verdicts = await Promise.all(tasks.map((task) => {
    let verdict = allowed.get(task.childSessionId)
    if (!verdict) allowed.set(task.childSessionId, verdict = authorize(task.childSessionId))
    return verdict
  }))
  return tasks.filter((_, index) => verdicts[index])
}

export function registerDelegatedTaskRoutes(use: UseFn): void {
  // GET /api/delegated-tasks?sessionId=<id>[&view=counts]
  use("/api/delegated-tasks", async (req, res, next) => {
    if (req.method === "GET") {
      try {
        const params = new URL(req.url || "/", "http://localhost").searchParams
        const parentSessionId = params.get("sessionId")
        if (!parentSessionId) return sendJson(res, 400, { error: "sessionId is required" })
        if (await authorizeSession(req, res, { sessionId: parentSessionId }, "view") === null) return
        const authority = delegationAuthority(req, "view")
        const scope = commandScope(req)
        if (params.get("view") === "counts") {
          const tasks = await visible(orchestrationStore().taskStates(scope, { parentSessionId }), (id) => authority.authorize(id))
          const counts = countDelegatedTasks(tasks)
          if (counts.unread) resumeDelegations(req, parentSessionId)
          return sendJsonWithEtag(req, res, { counts })
        }
        const tasks = await visible(orchestrationStore().tasks(scope, parentSessionId), (id) => authority.authorize(id))
        if (tasks.some(isUnreadTask)) resumeDelegations(req, parentSessionId)
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
        const stored = orchestrationStore().task(scope, body.taskId)
        if (!stored || stored.parentSessionId !== body.sessionId) return sendJson(res, 404, { error: "Delegated task not found" })
        if (await authorizeSession(req, res, { sessionId: stored.childSessionId }, "interact") === null) return
        const task = body.action === "ack" ? acknowledgeTask(scope, body.sessionId, body.taskId) : body.action === "cancel" ? await cancelTask(scope, body.sessionId, body.taskId, delegationAuthority(req)) : null
        if (!task) return sendJson(res, 400, { error: "Choose ack or cancel" })
        sendJson(res, 200, { task })
      } catch (error) { sendAgentError(res, error, "Failed to update delegated task") }
    })
  })
}
