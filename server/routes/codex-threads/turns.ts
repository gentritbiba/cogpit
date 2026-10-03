import type { IncomingMessage, ServerResponse } from "node:http"
import { isRecord } from "../../../shared/objects"
import type { JsonObject, UserInput } from "../../agents/codexAppServer"
import { handPrompt, reportSessionEvent, type ActivitySessionRef } from "../../edition"
import { sendJson } from "../../http"
import {
  authorizeThread,
  parseThreadId,
  readJsonObject,
  RequestError,
  type CodexThreadClient,
} from "./request"

function steer(
  req: IncomingMessage,
  client: CodexThreadClient,
  session: ActivitySessionRef,
  input: string | UserInput[],
  expectedTurnId: string | undefined,
  receivedAt: number,
): Promise<unknown> {
  return handPrompt(
    req,
    { receivedAt, route: "steer", session, input },
    () => client.steerTurn(session.sessionId, input, expectedTurnId),
    "steered",
  )
}

/** The input items a steer may hand the agent: text, images, and items that name what they point at. */
const STEER_ITEM_TYPES: ReadonlySet<string> = new Set(["text", "image", "localImage", "skill", "mention"])

function parseSteerInput(body: JsonObject): string | UserInput[] {
  const input = body.input
  if (typeof input === "string") {
    if (!input.trim()) {
      throw new RequestError(400, "INVALID_INPUT", "input cannot be empty")
    }
    return input
  }
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    !input.every(
      (item) =>
        isRecord(item) && typeof item.type === "string" && STEER_ITEM_TYPES.has(item.type),
    )
  ) {
    throw new RequestError(
      400,
      "INVALID_INPUT",
      `input must be a non-empty string or an array of ${[...STEER_ITEM_TYPES].join(", ")} items`,
    )
  }
  return input as UserInput[]
}

export async function handleThreadAction(
  req: IncomingMessage,
  res: ServerResponse,
  client: CodexThreadClient,
  threadId: string,
  action: string,
): Promise<void> {
  if (action === "steer") {
    const body = await readJsonObject(req)
    const receivedAt = Date.now()
    const input = parseSteerInput(body)
    const expectedTurnId = Object.hasOwn(body, "expectedTurnId")
      ? parseThreadId(String(body.expectedTurnId ?? ""), "expectedTurnId")
      : undefined
    const session = await authorizeThread(req, res, threadId, "interact")
    if (session) sendJson(res, 200, await steer(req, client, session, input, expectedTurnId, receivedAt))
    return
  }

  const body = await readJsonObject(req, { allowEmpty: true })
  const turnId = Object.hasOwn(body, "turnId")
    ? parseThreadId(String(body.turnId ?? ""), "turnId")
    : undefined
  const session = await authorizeThread(req, res, threadId, "interact")
  if (!session) return
  await client.interruptTurn(session.sessionId, turnId)
  reportSessionEvent(req, "session.interrupt", session, turnId ? { turnId } : undefined)
  sendJson(res, 200, { success: true, ...(turnId ? { turnId } : {}) })
}
