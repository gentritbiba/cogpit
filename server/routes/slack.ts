import type { SlackLinksReport } from "../../shared/contracts/slack"
import { editionModule, markDecided, mayActHostWide } from "../edition"
import { sendJson, withJsonBody, type UseFn } from "../http"
import { getSessionMeta, sessionMetaTitle } from "../sessionMetadata"
import { findJsonlPath } from "../sessionPaths"
import { slackService } from "../slack"
import { SlackLinkError } from "../slack/service"

/** A linked session's title as the transcript gives it; null when the transcript is gone. */
async function sessionTitle(sessionId: string): Promise<string | null> {
  const filePath = await findJsonlPath(sessionId)
  const meta = filePath ? await getSessionMeta(filePath).catch(() => null) : null
  return meta ? sessionMetaTitle(meta) || null : null
}

/**
 * GET  /api/slack  — bots (never their tokens) and links with their state.
 * POST /api/slack  — `{ action: "update", sessionId, autoPost?, dailyCap? }`
 *                    or `{ action: "unlink", sessionId }`.
 *
 * Host administrators only. Adding a bot and linking stay in
 * `cogpit-session slack`, so tokens are read from files on the host and never
 * cross the browser.
 */
export function registerSlackRoutes(use: UseFn) {
  use("/api/slack", async (req, res, next) => {
    const path = new URL(req.url || "/", "http://localhost").pathname
    if (path !== "/" && path !== "") return next()
    if (req.method !== "GET" && req.method !== "POST") return next()
    markDecided(req)
    if (!mayActHostWide(req)) return sendJson(res, 403, { error: "Only a host administrator can manage Slack links" })
    if (req.method === "GET") {
      const status = await slackService().status()
      const links = await Promise.all(status.links.map(async (link) => ({ ...link, title: await sessionTitle(link.sessionId) })))
      return sendJson(res, 200, { available: !editionModule().auth, bots: status.bots, links } satisfies SlackLinksReport)
    }
    withJsonBody<Record<string, unknown>>(req, res, async (body) => {
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : ""
      if (!sessionId) return sendJson(res, 400, { error: "sessionId is required" })
      try {
        if (body.action === "unlink") return sendJson(res, 200, await slackService().unlink(sessionId))
        if (body.action !== "update") return sendJson(res, 400, { error: "Unknown Slack action" })
        const { autoPost, dailyCap } = body
        if (autoPost !== undefined && typeof autoPost !== "boolean") return sendJson(res, 400, { error: "autoPost must be a boolean" })
        if (dailyCap !== undefined && typeof dailyCap !== "number") return sendJson(res, 400, { error: "dailyCap must be a number" })
        sendJson(res, 200, { link: await slackService().update(sessionId, { autoPost, dailyCap }) })
      } catch (error) {
        if (error instanceof SlackLinkError) return sendJson(res, 400, { error: error.message })
        throw error
      }
    })
  })
}
