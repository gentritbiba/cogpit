import { authorizeSession } from "../edition"
import { crewChatContext, crewChatReadContext, postCrewChat, readCrewChat, setCrewChatListening, type CrewChatContext } from "../lib/crewChat"
import { sendJsonWithEtag } from "../lib/jsonEtag"
import { sendJson, singlePathParam, withJsonBody, type UseFn } from "../http"
import type { CrewChatPageResponse } from "../../shared/contracts/crewChat"
import { sendHostError } from "./agentErrors"

export function registerCrewChatRoutes(use: UseFn): void {
  // GET /api/crew-chat/:id[?after|before&limit&knownMembers=<membersVersion>]
  use("/api/crew-chat/", (req, res, next) => {
    const sessionId = singlePathParam(req)
    if (!sessionId || !["GET", "POST", "PATCH"].includes(req.method ?? "")) return next()
    /** The crew once the caller may use both the session and its lead; null once refused. */
    const authorize = async (read: (id: string) => Promise<CrewChatContext>): Promise<CrewChatContext | null> => {
      const level = req.method === "POST" ? "interact" : "view"
      if (await authorizeSession(req, res, { sessionId }, level) === null) return null
      const context = await read(sessionId)
      return context.rootId === sessionId || await authorizeSession(req, res, { sessionId: context.rootId }, level) !== null ? context : null
    }
    if (req.method === "GET") return (async () => {
      try {
        const context = await authorize((id) => crewChatReadContext(id, req))
        if (!context) return
        const params = new URL(req.url || "/", "http://localhost").searchParams
        const number = (name: string) => params.has(name) ? Number(params.get(name)) : undefined
        const { members, ...page } = await readCrewChat(sessionId, { after: number("after"), before: number("before"), limit: number("limit") }, req, context)
        const response: CrewChatPageResponse = params.get("knownMembers") === page.membersVersion ? page : { ...page, members }
        return sendJsonWithEtag(req, res, response)
      } catch (error) { sendHostError(res, error, "Couldn't load crew chat") }
    })()
    withJsonBody<Record<string, unknown>>(req, res, async (body) => {
      try {
        const context = await authorize((id) => crewChatContext(id, req))
        if (!context) return
        if (req.method === "PATCH") {
          if (typeof body.sessionId !== "string" || typeof body.listening !== "boolean") return sendJson(res, 400, { error: "sessionId and listening are required" })
          if (await authorizeSession(req, res, { sessionId: body.sessionId }, "interact") === null) return
          return sendJson(res, 200, await setCrewChatListening(sessionId, body.sessionId, body.listening, req, context))
        }
        if (typeof body.text !== "string" || typeof body.commandId !== "string" || (body.mentions !== undefined && (!Array.isArray(body.mentions) || body.mentions.some((id) => typeof id !== "string"))) || (body.senderSessionId !== undefined && typeof body.senderSessionId !== "string")) return sendJson(res, 400, { error: "text, commandId and optional member mentions are required" })
        sendJson(res, 200, await postCrewChat(sessionId, { text: body.text, commandId: body.commandId, mentions: body.mentions as string[] | undefined, senderSessionId: body.senderSessionId as string | undefined }, req, context))
      } catch (error) { sendHostError(res, error, "Couldn't update crew chat") }
    })
  })
}
