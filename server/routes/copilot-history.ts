import type { ServerResponse } from "node:http"
import { copilotRuntime, type CopilotRewindMode, type CopilotRuntime } from "../copilot-runtime"
import { findJsonlPath, isCopilotFilePath } from "../helpers"
import { sendJson, type UseFn, withJsonBody } from "../http"

type CopilotHistoryClient = Pick<
  CopilotRuntime,
  "isSessionActive" | "resumeSession" | "destroySession" | "listRewindPoints" | "previewRewind" | "rewind"
>

async function ensureCopilotSession(
  sessionId: string,
  runtime: CopilotHistoryClient,
): Promise<"active" | "resumed" | null> {
  const filePath = await findJsonlPath(sessionId)
  if (!filePath || !isCopilotFilePath(filePath)) return null
  if (runtime.isSessionActive(sessionId)) return "active"
  await runtime.resumeSession(sessionId)
  return "resumed"
}

async function releaseInspectedSession(
  sessionId: string,
  state: "active" | "resumed" | null,
  runtime: CopilotHistoryClient,
): Promise<void> {
  if (state === "resumed" && runtime.isSessionActive(sessionId)) {
    await runtime.destroySession(sessionId).catch(() => {})
  }
}

async function respondFromInspectedSession(
  res: ServerResponse,
  sessionId: string,
  runtime: CopilotHistoryClient,
  failureMessage: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  let state: "active" | "resumed" | null = null
  try {
    state = await ensureCopilotSession(sessionId, runtime)
    if (!state) {
      sendJson(res, 404, { error: "Copilot session not found" })
      return
    }
    sendJson(res, 200, await operation())
  } catch (error) {
    sendJson(res, 502, {
      error: error instanceof Error ? error.message : failureMessage,
    })
  } finally {
    await releaseInspectedSession(sessionId, state, runtime)
  }
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
      void respondFromInspectedSession(
        res,
        sessionId,
        runtime,
        "Failed to list Copilot rewind points",
        () => runtime.listRewindPoints(sessionId),
      )
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
        await respondFromInspectedSession(
          res,
          sessionId,
          runtime,
          "Failed to preview Copilot rewind",
          () => runtime.previewRewind(sessionId, eventId),
        )
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
          await respondFromInspectedSession(
            res,
            sessionId,
            runtime,
            "Failed to rewind Copilot session",
            () => runtime.rewind(sessionId, eventId, mode as CopilotRewindMode),
          )
        },
      )
      return
    }

    next()
  })
}
