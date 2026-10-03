import { codexAppServer } from "../../agents/codexAppServer"
import type { UseFn } from "../../http"
import { handleGoal } from "./goals"
import { parseThreadId, pathParts, sendRouteError, type CodexThreadClient } from "./request"
import { handleThreadAction } from "./turns"

export type { CodexThreadClient }

/**
 * Goals and direct turn control are Codex-only capabilities with no analogue in
 * the other CLIs, so they keep a route module of their own rather than being
 * pushed into `AgentRuntime` as three methods only one agent can answer.
 */
export function registerCodexThreadRoutes(
  use: UseFn,
  client: CodexThreadClient = codexAppServer,
): void {
  use("/api/codex/goals", (req, res, next) => {
    const parts = pathParts(req.url)
    if (
      parts.length !== 1 ||
      (req.method !== "GET" &&
        req.method !== "POST" &&
        req.method !== "DELETE")
    ) {
      next()
      return
    }
    try {
      const threadId = parseThreadId(parts[0])
      void handleGoal(req, res, client, threadId).catch((error) =>
        sendRouteError(res, error),
      )
    } catch (error) {
      sendRouteError(res, error)
    }
  })

  use("/api/codex/threads", (req, res, next) => {
    const parts = pathParts(req.url)
    if (
      req.method !== "POST" ||
      parts.length !== 2 ||
      (parts[1] !== "steer" && parts[1] !== "interrupt")
    ) {
      next()
      return
    }
    try {
      const threadId = parseThreadId(parts[0])
      void handleThreadAction(req, res, client, threadId, parts[1]).catch(
        (error) => sendRouteError(res, error),
      )
    } catch (error) {
      sendRouteError(res, error)
    }
  })
}
