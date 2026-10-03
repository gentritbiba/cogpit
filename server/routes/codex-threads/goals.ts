import type { IncomingMessage, ServerResponse } from "node:http"
import type { JsonObject, ThreadGoalResponse } from "../../agents/codexAppServer"
import { handPrompt, reportSessionEvent, type ActivitySessionRef } from "../../edition"
import { sendJson } from "../../http"
import { authorizeThread, readJsonObject, RequestError, type CodexThreadClient } from "./request"

const GOAL_STATUSES = new Set([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
])

type GoalUpdate = { objective?: string; status?: string; tokenBudget?: number | null }

function parseGoalUpdate(body: JsonObject): GoalUpdate {
  const update: GoalUpdate = {}
  if (Object.hasOwn(body, "objective")) {
    if (
      typeof body.objective !== "string" ||
      body.objective.trim().length === 0 ||
      body.objective.length > 4_000
    ) {
      throw new RequestError(
        400,
        "INVALID_GOAL",
        "objective must be a non-empty string of at most 4000 characters",
      )
    }
    update.objective = body.objective
  }
  if (Object.hasOwn(body, "status")) {
    if (typeof body.status !== "string" || !GOAL_STATUSES.has(body.status)) {
      throw new RequestError(400, "INVALID_GOAL", "status is invalid")
    }
    update.status = body.status
  }
  if (Object.hasOwn(body, "tokenBudget")) {
    if (
      body.tokenBudget !== null &&
      (!Number.isSafeInteger(body.tokenBudget) ||
        (body.tokenBudget as number) <= 0)
    ) {
      throw new RequestError(
        400,
        "INVALID_GOAL",
        "tokenBudget must be a positive integer or null",
      )
    }
    update.tokenBudget = body.tokenBudget as number | null
  }
  if (Object.keys(update).length === 0) {
    throw new RequestError(
      400,
      "INVALID_GOAL",
      "At least one goal field is required",
    )
  }
  return update
}

/**
 * Set a goal, handing its objective over as a prompt that starts a turn: the
 * agent works toward it in the turns the goal drives, now or once it resumes,
 * so those turns are the setter's.
 */
async function setGoal(
  req: IncomingMessage,
  client: CodexThreadClient,
  session: ActivitySessionRef,
  update: GoalUpdate,
  receivedAt: number,
): Promise<ThreadGoalResponse> {
  const { objective, ...settings } = update
  const set = () => client.setGoal(session.sessionId, update)
  const result = objective === undefined
    ? await set()
    : await handPrompt(req, { receivedAt, route: "goal", session, input: objective }, set, "started")
  if (Object.keys(settings).length > 0) reportSessionEvent(req, "session.goal", session, settings)
  return result
}

export async function handleGoal(
  req: IncomingMessage,
  res: ServerResponse,
  client: CodexThreadClient,
  threadId: string,
): Promise<void> {
  if (req.method === "GET") {
    const session = await authorizeThread(req, res, threadId, "view")
    if (session) sendJson(res, 200, await client.getGoal(session.sessionId))
    return
  }
  if (req.method === "POST") {
    const update = parseGoalUpdate(await readJsonObject(req))
    const receivedAt = Date.now()
    const session = await authorizeThread(req, res, threadId, "interact")
    if (session) sendJson(res, 200, await setGoal(req, client, session, update, receivedAt))
    return
  }
  const session = await authorizeThread(req, res, threadId, "interact")
  if (!session) return
  const result = await client.clearGoal(session.sessionId)
  if (result.cleared) reportSessionEvent(req, "session.goal", session, { cleared: true })
  sendJson(res, 200, result)
}
