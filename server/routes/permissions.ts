import { sendJson, type UseFn, withJsonBody } from "../http"
import { getToolSummary } from "../../shared/session/toolSummary"
import type { MissionControlPermission } from "../../shared/contracts/missionControl"
import { persistentSessions } from "../processRegistry"
import {
  allRuntimes as defaultAllRuntimes,
  runtimeForSession as defaultRuntimeForSession,
  type AgentRuntime,
  type ApprovalDecision,
  type PendingApproval,
} from "../agents/runtimes"
import { copilotRuntime, type CopilotExitPlanResponse, type CopilotRuntime } from "../agents/copilotTransport"
import { sendAgentError } from "./agentErrors"

/**
 * The permission bar's server side: what is blocking a session, and how the
 * user's answer reaches the agent that asked.
 *
 * Requests are collected from the runtime that actually holds the session, not
 * from a fixed agent precedence — the old code took whichever registry answered
 * first with a non-empty list, so a live session with nothing pending handed its
 * id to the next agent in line. Answering goes through one shared codec, so
 * "always allow" degrades to a one-time allow the same way everywhere and a
 * decision an agent cannot express is refused rather than quietly narrowed.
 */

export type CopilotPlanClient = Pick<CopilotRuntime, "getPendingExitPlans" | "answerExitPlan">

/** Test seam: the registry lookups this module resolves sessions through. */
export interface PermissionRuntimes {
  allRuntimes(): readonly AgentRuntime[]
  runtimeForSession(sessionId: string): AgentRuntime | null
}

const DEFAULT_RUNTIMES: PermissionRuntimes = {
  allRuntimes: defaultAllRuntimes,
  runtimeForSession: defaultRuntimeForSession,
}

/** Pending requests for one session. */
export function collectPendingPermissions(
  sessionId: string,
  runtimes: PermissionRuntimes = DEFAULT_RUNTIMES,
): PendingApproval[] {
  const runtime = runtimes.runtimeForSession(sessionId)
  return runtime ? runtime.listPendingApprovals(sessionId) : []
}

/** Every session id currently holding a pending request. */
export function listPermissionSessionIds(
  runtimes: PermissionRuntimes = DEFAULT_RUNTIMES,
): string[] {
  const ids = new Set<string>()
  for (const runtime of runtimes.allRuntimes()) {
    for (const approval of runtime.listPendingApprovals()) ids.add(approval.sessionId)
  }
  return [...ids]
}

/**
 * Reduce one request to what a dashboard card renders.
 *
 * The raw `input` is the complete tool input — for a pending Write, the entire
 * file being written. This list is polled app-wide, so shipping it would put
 * that payload on the wire every few seconds for every connected client,
 * including remote and tunnel ones. The card only ever shows a one-line
 * summary, so that is all it gets. (The per-session route below still returns
 * the full input; the permission bar needs it to render.)
 */
function summarizeRequest(
  sessionId: string,
  request: PendingApproval,
): MissionControlPermission {
  return {
    sessionId,
    requestId: request.requestId,
    toolName: request.toolName,
    summary: getToolSummary({ name: request.toolName, input: request.input }),
    ...(request.title && { title: request.title }),
    ...(request.description && { description: request.description }),
    ...(request.availableDecisions && { availableDecisions: request.availableDecisions }),
    timestamp: request.timestamp,
  }
}

export function registerPermissionRoutes(
  use: UseFn,
  runtimes: PermissionRuntimes = DEFAULT_RUNTIMES,
  copilot: CopilotPlanClient = copilotRuntime,
) {
  use("/api/permissions", (req, res, next) => {
    const url = req.url ?? ""

    // GET /api/permissions — every pending request, grouped by session. Powers
    // the Mission Control grid, which must surface requests for sessions that
    // are not open.
    if (req.method === "GET" && (url === "" || url === "/" || url.startsWith("?"))) {
      const bySession: Record<string, MissionControlPermission[]> = {}
      for (const sessionId of listPermissionSessionIds(runtimes)) {
        const permissions = collectPendingPermissions(sessionId, runtimes)
        if (permissions.length > 0) {
          bySession[sessionId] = permissions.map((r) => summarizeRequest(sessionId, r))
        }
      }
      const plansBySession: Record<
        string,
        Array<{ sessionId: string; requestId: string; summary: string }>
      > = {}
      for (const { sessionId, requestId, summary } of copilot.getPendingExitPlans()) {
        const plans = plansBySession[sessionId] ??= []
        plans.push({ sessionId, requestId, summary })
      }
      sendJson(res, 200, { bySession, plansBySession })
      return
    }

    // GET /api/permissions/:sessionId — return pending permission requests
    const getMatch = url.match(/^\/([^/?]+)$/)
    if (req.method === "GET" && getMatch) {
      const sessionId = decodeURIComponent(getMatch[1])
      sendJson(res, 200, {
        permissions: collectPendingPermissions(sessionId, runtimes),
        plan: copilot.getPendingExitPlans(sessionId)[0] ?? null,
      })
      return
    }

    const planMatch = url.match(/^\/([^/?]+)\/plan$/)
    if (req.method === "POST" && planMatch) {
      const sessionId = decodeURIComponent(planMatch[1])
      withJsonBody<unknown>(req, res, (body) => {
        try {
          const { requestId, approved, selectedAction, feedback } = body as Record<string, unknown>
          if (typeof requestId !== "string" || !requestId) {
            sendJson(res, 400, { error: "requestId is required" })
            return
          }
          if (typeof approved !== "boolean") {
            sendJson(res, 400, { error: "approved must be a boolean" })
            return
          }
          if (selectedAction !== undefined && typeof selectedAction !== "string") {
            sendJson(res, 400, { error: "selectedAction must be a string" })
            return
          }
          if (feedback !== undefined && typeof feedback !== "string") {
            sendJson(res, 400, { error: "feedback must be a string" })
            return
          }
          const pending = copilot
            .getPendingExitPlans(sessionId)
            .find((plan) => plan.requestId === requestId)
          if (!pending) {
            sendJson(res, 404, { error: "Plan request not found or already resolved" })
            return
          }
          const response: CopilotExitPlanResponse = {
            approved,
            ...(selectedAction ? { selectedAction } : {}),
            ...(feedback ? { feedback } : {}),
          }
          try {
            copilot.answerExitPlan(sessionId, requestId, response)
          } catch (error) {
            sendJson(res, 400, {
              error: error instanceof Error ? error.message : "Failed to answer Copilot plan",
            })
            return
          }
          sendJson(res, 200, { success: true })
        } catch {
          sendJson(res, 400, { error: "Invalid JSON body" })
        }
      })
      return
    }

    // POST /api/permissions/:sessionId/respond — approve/deny a single tool
    const respondMatch = url.match(/^\/([^/?]+)\/respond$/)
    if (req.method === "POST" && respondMatch) {
      const sessionId = decodeURIComponent(respondMatch[1])
      withJsonBody<unknown>(req, res, async (body) => {
        let behavior: ApprovalDecision
        let requestId: string
        try {
          const parsed = body as Record<string, unknown>
          requestId = parsed.requestId as string
          behavior = parsed.behavior as ApprovalDecision
        } catch {
          sendJson(res, 400, { error: "Invalid JSON body" })
          return
        }
        if (typeof requestId !== "string" || !requestId) {
          sendJson(res, 400, { error: "requestId is required" })
          return
        }
        if (behavior !== "allow" && behavior !== "allow_always" && behavior !== "deny") {
          sendJson(res, 400, { error: "behavior must be 'allow', 'allow_always', or 'deny'" })
          return
        }

        const runtime = runtimes.runtimeForSession(sessionId)
        if (!runtime) {
          sendJson(res, 404, {
            error: persistentSessions.has(sessionId)
              ? "Permission request not found or already resolved"
              : "Session not found",
          })
          return
        }
        const request = runtime
          .listPendingApprovals(sessionId)
          .find((pending) => pending.requestId === requestId)
        try {
          const handled = await runtime.respondToApproval(sessionId, requestId, behavior)
          if (!handled) {
            sendJson(res, 404, { error: "Permission request not found or already resolved" })
            return
          }
        } catch (error) {
          sendAgentError(res, error, "Failed to resolve the permission request")
          return
        }
        sendJson(res, 200, {
          success: true,
          action: behavior === "deny" ? "denied" : "allowed",
          toolName: request?.toolName,
          ...(runtime.kind === "claude" ? {} : { shouldRetry: false }),
        })
      })
      return
    }

    // POST /api/permissions/:sessionId/respond-all — batch approve/deny
    const respondAllMatch = url.match(/^\/([^/?]+)\/respond-all$/)
    if (req.method === "POST" && respondAllMatch) {
      const sessionId = decodeURIComponent(respondAllMatch[1])
      withJsonBody<unknown>(req, res, async (body) => {
        let behavior: ApprovalDecision
        try {
          behavior = (body as Record<string, unknown>).behavior as ApprovalDecision
        } catch {
          sendJson(res, 400, { error: "Invalid JSON body" })
          return
        }
        if (behavior !== "allow" && behavior !== "allow_always" && behavior !== "deny") {
          sendJson(res, 400, { error: "behavior must be 'allow', 'allow_always', or 'deny'" })
          return
        }

        const runtime = runtimes.runtimeForSession(sessionId)
        if (!runtime) {
          sendJson(res, 404, { error: "Session not found" })
          return
        }
        try {
          const { count, toolNames } = await runtime.respondToAllApprovals(sessionId, behavior)
          sendJson(res, 200, {
            success: true,
            action: behavior === "deny" ? "denied" : "allowed",
            count,
            toolNames,
            ...(runtime.kind === "claude" ? {} : { shouldRetry: false }),
          })
        } catch (error) {
          sendAgentError(res, error, "Failed to resolve the permission requests")
        }
      })
      return
    }

    next()
  })
}
