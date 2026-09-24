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
import { authorizeSession, reportSessionEvent } from "../edition"
import { sendAgentError } from "./agentErrors"
import { visibleBySession } from "./visibleBySession"

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
    ...(request.defaultToNo && { defaultToNo: true }),
    timestamp: request.timestamp,
  }
}

interface PlanAnswer {
  requestId: string
  response: CopilotExitPlanResponse
}

/** The plan answer a body carries, or why it carries none. */
function parsePlanAnswer(body: unknown): PlanAnswer | string {
  if (body === null || body === undefined) return "Invalid JSON body"
  const { requestId, approved, selectedAction, feedback } = body as Record<string, unknown>
  if (typeof requestId !== "string" || !requestId) return "requestId is required"
  if (typeof approved !== "boolean") return "approved must be a boolean"
  if (selectedAction !== undefined && typeof selectedAction !== "string") return "selectedAction must be a string"
  if (feedback !== undefined && typeof feedback !== "string") return "feedback must be a string"
  return {
    requestId,
    response: {
      approved,
      ...(selectedAction ? { selectedAction } : {}),
      ...(feedback ? { feedback } : {}),
    },
  }
}

export function registerPermissionRoutes(
  use: UseFn,
  runtimes: PermissionRuntimes = DEFAULT_RUNTIMES,
  copilot: CopilotPlanClient = copilotRuntime,
) {
  use("/api/permissions", async (req, res, next) => {
    // A mounted router hands the bare path on as "", "/" or "/?query".
    const path = (req.url ?? "").split("?")[0]

    // GET /api/permissions — every pending request the caller may see, grouped
    // by session. Powers the Mission Control grid, which must surface requests
    // for sessions that are not open.
    if (req.method === "GET" && (path === "" || path === "/")) {
      const permissions = listPermissionSessionIds(runtimes).flatMap((sessionId) =>
        collectPendingPermissions(sessionId, runtimes).map((request) => summarizeRequest(sessionId, request)),
      )
      const plans = copilot.getPendingExitPlans().map(({ sessionId, requestId, summary }) => ({ sessionId, requestId, summary }))
      sendJson(res, 200, {
        bySession: await visibleBySession(req, permissions),
        plansBySession: await visibleBySession(req, plans),
      })
      return
    }

    // GET /api/permissions/:sessionId — return pending permission requests
    const getMatch = path.match(/^\/([^/]+)$/)
    if (req.method === "GET" && getMatch) {
      const sessionId = decodeURIComponent(getMatch[1])
      if (await authorizeSession(req, res, { sessionId }, "view") === null) return
      sendJson(res, 200, {
        permissions: collectPendingPermissions(sessionId, runtimes),
        plan: copilot.getPendingExitPlans(sessionId)[0] ?? null,
      })
      return
    }

    const planMatch = path.match(/^\/([^/]+)\/plan$/)
    if (req.method === "POST" && planMatch) {
      const sessionId = decodeURIComponent(planMatch[1])
      withJsonBody<unknown>(req, res, async (body) => {
        const answer = parsePlanAnswer(body)
        if (typeof answer === "string") {
          sendJson(res, 400, { error: answer })
          return
        }
        const authorized = await authorizeSession(req, res, { sessionId }, "interact")
        if (authorized === null) return
        // A plan waits inside a live session, so the runtime holding it names the agent.
        const runtime = runtimes.runtimeForSession(sessionId)
        const pending = copilot
          .getPendingExitPlans(sessionId)
          .find((plan) => plan.requestId === answer.requestId)
        if (!runtime || !pending) {
          sendJson(res, 404, { error: "Plan request not found or already resolved" })
          return
        }
        try {
          copilot.answerExitPlan(sessionId, answer.requestId, answer.response)
        } catch (error) {
          sendJson(res, 400, {
            error: error instanceof Error ? error.message : "Failed to answer Copilot plan",
          })
          return
        }
        reportSessionEvent(req, "session.permission", { sessionId: authorized.sessionId, agent: runtime.kind }, {
          requestId: answer.requestId,
          ...answer.response,
        })
        sendJson(res, 200, { success: true })
      })
      return
    }

    // POST /api/permissions/:sessionId/respond — approve/deny a single tool
    const respondMatch = path.match(/^\/([^/]+)\/respond$/)
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
        const authorized = await authorizeSession(req, res, { sessionId }, "interact")
        if (authorized === null) return

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
        reportSessionEvent(req, "session.permission", { sessionId: authorized.sessionId, agent: runtime.kind }, {
          requestId,
          toolUseId: request?.toolUseId,
          toolName: request?.toolName,
          behavior,
        })
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
    const respondAllMatch = path.match(/^\/([^/]+)\/respond-all$/)
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
        const authorized = await authorizeSession(req, res, { sessionId }, "interact")
        if (authorized === null) return

        const runtime = runtimes.runtimeForSession(sessionId)
        if (!runtime) {
          sendJson(res, 404, { error: "Session not found" })
          return
        }
        try {
          const resolved = await runtime.respondToAllApprovals(sessionId, behavior)
          if (resolved.length > 0) {
            reportSessionEvent(req, "session.permission", { sessionId: authorized.sessionId, agent: runtime.kind }, { behavior, resolved })
          }
          sendJson(res, 200, {
            success: true,
            action: behavior === "deny" ? "denied" : "allowed",
            count: resolved.length,
            toolNames: [...new Set(resolved.map(({ toolName }) => toolName))],
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
