import { copilotRuntime, type CopilotRewindMode, type CopilotRuntime } from "../copilot-runtime"
import { findJsonlPath, isCopilotFilePath } from "../helpers"
import { sendJson, type UseFn, withJsonBody } from "../http"

type CopilotHistoryClient = Pick<
  CopilotRuntime,
  "isSessionActive" | "resumeSession" | "listRewindPoints" | "previewRewind" | "rewind"
>

async function ensureCopilotSession(
  sessionId: string,
  runtime: CopilotHistoryClient,
): Promise<boolean> {
  const filePath = await findJsonlPath(sessionId)
  if (!filePath || !isCopilotFilePath(filePath)) return false
  if (!runtime.isSessionActive(sessionId)) await runtime.resumeSession(sessionId)
  return true
}

export function registerCopilotHistoryRoutes(
  use: UseFn,
  runtime: CopilotHistoryClient = copilotRuntime,
) {
  use("/api/copilot-history", (req, res, next) => {
    const url = req.url ?? ""
    const listMatch = /^\/([^/?]+)$/.exec(url)
    if (req.method === "GET" && listMatch) {
      const sessionId = decodeURIComponent(listMatch[1])
      void (async () => {
        try {
          if (!await ensureCopilotSession(sessionId, runtime)) {
            sendJson(res, 404, { error: "Copilot session not found" })
            return
          }
          sendJson(res, 200, await runtime.listRewindPoints(sessionId))
        } catch (error) {
          sendJson(res, 502, {
            error: error instanceof Error ? error.message : "Failed to list Copilot rewind points",
          })
        }
      })()
      return
    }

    const previewMatch = /^\/([^/?]+)\/preview$/.exec(url)
    if (req.method === "POST" && previewMatch) {
      const sessionId = decodeURIComponent(previewMatch[1])
      withJsonBody<{ eventId?: unknown }>(req, res, async ({ eventId }) => {
        if (typeof eventId !== "string" || !eventId) {
          sendJson(res, 400, { error: "eventId is required" })
          return
        }
        try {
          if (!await ensureCopilotSession(sessionId, runtime)) {
            sendJson(res, 404, { error: "Copilot session not found" })
            return
          }
          sendJson(res, 200, await runtime.previewRewind(sessionId, eventId))
        } catch (error) {
          sendJson(res, 502, {
            error: error instanceof Error ? error.message : "Failed to preview Copilot rewind",
          })
        }
      })
      return
    }

    const rewindMatch = /^\/([^/?]+)\/rewind$/.exec(url)
    if (req.method === "POST" && rewindMatch) {
      const sessionId = decodeURIComponent(rewindMatch[1])
      withJsonBody<{ eventId?: unknown; mode?: unknown }>(
        req,
        res,
        async ({ eventId, mode }) => {
          if (typeof eventId !== "string" || !eventId) {
            sendJson(res, 400, { error: "eventId is required" })
            return
          }
          if (mode !== "conversation" && mode !== "conversation-and-files") {
            sendJson(res, 400, {
              error: "mode must be 'conversation' or 'conversation-and-files'",
            })
            return
          }
          try {
            if (!await ensureCopilotSession(sessionId, runtime)) {
              sendJson(res, 404, { error: "Copilot session not found" })
              return
            }
            sendJson(
              res,
              200,
              await runtime.rewind(sessionId, eventId, mode as CopilotRewindMode),
            )
          } catch (error) {
            sendJson(res, 502, {
              error: error instanceof Error ? error.message : "Failed to rewind Copilot session",
            })
          }
        },
      )
      return
    }

    next()
  })
}
