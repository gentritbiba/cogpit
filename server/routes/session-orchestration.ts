import type { IncomingMessage, ServerResponse } from "node:http"
import { isAbsolute } from "node:path"
import type { PendingInputResponse } from "../agents/pendingInput"
import type { UserQuestionAnswers } from "../agents/runtimes"
import { sessionChildren } from "../lib/sessionOrigins"
import { parseWaitSeconds } from "../lib/sessionWait"
import { sendJson, singlePathParam, withJsonBody, type UseFn } from "../http"
import { runSessionCli } from "../sessionCli/commands"
import { hostForSession, locateSessions, SESSION_SCOPE_HEADER, waitAcrossHosts } from "../sessionHosts"
import {
  listDelegatedRequests,
  markDelegatedRequestAnswered,
  watchDelegatedRequestsOf,
} from "../sessionHosts/delegatedRequests"
import { getRequestPrincipal, mayActHostWide, visibilityFor } from "../edition"
import { sendHostError } from "./agentErrors"

const INVOCATION_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/

/**
 * Endpoints for agents that drive other sessions: block until a session needs
 * someone, read what it produced, answer what it is blocked on, and list the
 * sessions an agent started. The `cogpit-session` CLI wraps these.
 *
 * A session id may belong to a hub device; each endpoint answers for it there.
 * A hub asking a device sends the local scope header, so the device answers
 * for itself only.
 */

const MAX_WAIT_SESSIONS = 50

/** Aborts when the caller hangs up, so an abandoned long poll stops polling. */
function abortOnClose(req: IncomingMessage, res: ServerResponse): AbortSignal {
  const controller = new AbortController()
  res.on("close", () => controller.abort())
  req.on("aborted", () => controller.abort())
  return controller.signal
}

function scopeOf(req: IncomingMessage): { localOnly: boolean } {
  return { localOnly: req.headers[SESSION_SCOPE_HEADER] === "local" }
}

export function registerSessionOrchestrationRoutes(use: UseFn) {
  // GET /api/session-wait/:sessionId?timeout=<s> — one session
  // POST /api/session-wait { sessionIds, mode: "any" | "all", timeout }
  use("/api/session-wait", async (req, res, next) => {
    if (req.method === "GET") {
      const sessionId = singlePathParam(req)
      if (!sessionId) return next()
      const timeout = parseWaitSeconds(new URL(req.url || "/", "http://localhost").searchParams.get("timeout"))
      if (timeout === null) return sendJson(res, 400, { error: "timeout must be a non-negative number of seconds" })
      const signal = abortOnClose(req, res)
      try {
        const located = await locateSessions([sessionId], scopeOf(req))
        const result = await waitAcrossHosts(located, { mode: "all", timeoutMs: timeout * 1000, signal })
        if (!res.writableEnded) sendJson(res, 200, { timedOut: result.timedOut, ...result.sessions[0] })
      } catch (error) {
        if (!res.writableEnded) sendHostError(res, error, "Failed to wait on the session")
      }
      return
    }
    if (req.method !== "POST") return next()
    withJsonBody<{ sessionIds?: unknown; mode?: unknown; timeout?: unknown }>(req, res, async (body) => {
      const { sessionIds, mode = "all" } = body
      if (
        !Array.isArray(sessionIds)
        || sessionIds.length === 0
        || sessionIds.length > MAX_WAIT_SESSIONS
        || !sessionIds.every((id) => typeof id === "string" && id)
      ) {
        return sendJson(res, 400, { error: `sessionIds must list 1–${MAX_WAIT_SESSIONS} session ids` })
      }
      if (mode !== "any" && mode !== "all") return sendJson(res, 400, { error: "mode must be 'any' or 'all'" })
      const timeout = parseWaitSeconds(body.timeout)
      if (timeout === null) return sendJson(res, 400, { error: "timeout must be a non-negative number of seconds" })
      const signal = abortOnClose(req, res)
      try {
        const located = await locateSessions([...new Set(sessionIds as string[])], scopeOf(req))
        const result = await waitAcrossHosts(located, { mode, timeoutMs: timeout * 1000, signal })
        if (!res.writableEnded) sendJson(res, 200, result)
      } catch (error) {
        if (!res.writableEnded) sendHostError(res, error, "Failed to wait on the sessions")
      }
    })
  })

  // GET /api/session-result/:sessionId?turn=<index>
  use("/api/session-result/", async (req, res, next) => {
    if (req.method !== "GET") return next()
    const sessionId = singlePathParam(req)
    if (!sessionId) return next()
    const rawTurn = new URL(req.url || "/", "http://localhost").searchParams.get("turn")
    const turn = rawTurn === null ? undefined : Number.parseInt(rawTurn, 10)
    if (turn !== undefined && (!Number.isInteger(turn) || turn < 0)) {
      return sendJson(res, 400, { error: "turn must be a non-negative integer" })
    }
    try {
      const result = await (await hostForSession(sessionId, scopeOf(req))).result(sessionId, turn)
      if (!result) return sendJson(res, 404, { error: "Session not found" })
      sendJson(res, 200, result)
    } catch (error) {
      sendHostError(res, error, "Failed to read the session's result")
    }
  })

  // POST /api/session-respond { sessionId, requestId, decision | answers | approved, action?, feedback? }
  use("/api/session-respond", (req, res, next) => {
    if (req.method !== "POST") return next()
    withJsonBody<Record<string, unknown>>(req, res, async (body) => {
      const { sessionId, requestId } = body
      if (typeof sessionId !== "string" || !sessionId || typeof requestId !== "string" || !requestId) {
        return sendJson(res, 400, { error: "sessionId and requestId are required" })
      }
      const response = pendingInputResponseFrom(body)
      if (!response) {
        return sendJson(res, 400, {
          error: "Send one of: decision ('allow' | 'allow_always' | 'deny'), answers, or approved (boolean)",
        })
      }
      try {
        const host = await hostForSession(sessionId, scopeOf(req))
        const answered = await host.respond(sessionId, requestId, response)
        markDelegatedRequestAnswered(sessionId, requestId)
        sendJson(res, 200, { success: true, answered })
      } catch (error) {
        sendHostError(res, error, "Failed to answer the request")
      }
    })
  })

  // GET /api/session-children/:sessionId — sessions it started, with their state
  use("/api/session-children/", async (req, res, next) => {
    if (req.method !== "GET") return next()
    const sessionId = singlePathParam(req)
    if (!sessionId) return next()
    const located = await locateSessions(await sessionChildren(sessionId))
    const children = await Promise.all(located.map(async ({ host, sessionId: childId }) => ({
      ...await host.state(childId),
      ...(host.remote ? { device: { id: host.id, name: host.name } } : {}),
    })))
    sendJson(res, 200, { sessionId, children })
  })

  // POST /api/session-send { sessionId, message, interrupt? } — deliver a
  // follow-up and answer at once; `session-wait` reports how the turn ends.
  use("/api/session-send", (req, res, next) => {
    if (req.method !== "POST") return next()
    withJsonBody<Record<string, unknown>>(req, res, async (body) => {
      const { sessionId, message, interrupt } = body
      if (typeof sessionId !== "string" || !sessionId || typeof message !== "string" || !message.trim()) {
        return sendJson(res, 400, { error: "sessionId and message are required" })
      }
      try {
        const host = await hostForSession(sessionId, scopeOf(req))
        const delivered = await host.send(sessionId, message, { interrupt: interrupt === true })
        watchDelegatedRequestsOf(sessionId)
        sendJson(res, 200, delivered)
      } catch (error) {
        sendHostError(res, error, "The agent failed to accept the message")
      }
    })
  })

  // GET /api/session-requests?parent=<sessionId> — what delegated sessions
  // whose questions go to the user are waiting on, for the parent's view.
  use("/api/session-requests", (req, res, next) => {
    if (req.method !== "GET") return next()
    const parent = new URL(req.url || "/", "http://localhost").searchParams.get("parent")
    if (!parent) return sendJson(res, 400, { error: "parent is required" })
    sendJson(res, 200, { requests: listDelegatedRequests(parent) })
  })

  // POST /api/session-cli { argv, cwd, invocationId, callerSessionId? } — the
  // `cogpit-session` script's only call; answers { exitCode, stdout, stderr }.
  use("/api/session-cli", (req, res, next) => {
    if (req.method !== "POST") return next()
    withJsonBody<Record<string, unknown>>(req, res, async (body) => {
      const { argv, cwd, invocationId, callerSessionId } = body
      if (!Array.isArray(argv) || !argv.every((arg) => typeof arg === "string")) {
        return sendJson(res, 400, { error: "argv must be an array of strings" })
      }
      if (typeof cwd !== "string" || !isAbsolute(cwd)) {
        return sendJson(res, 400, { error: "cwd must be an absolute path" })
      }
      if (typeof invocationId !== "string" || !INVOCATION_ID_RE.test(invocationId)) {
        return sendJson(res, 400, { error: "invocationId must be 8–128 letters, digits, - or _" })
      }
      const output = await runSessionCli({
        argv,
        cwd,
        invocationId,
        callerSessionId: typeof callerSessionId === "string" && callerSessionId ? callerSessionId : undefined,
        scope: getRequestPrincipal(req)?.userId ?? "local",
        admin: mayActHostWide(req),
        visible: visibilityFor(req),
        signal: abortOnClose(req, res),
      })
      if (!res.writableEnded) sendJson(res, 200, output)
    })
  })
}

export function pendingInputResponseFrom(body: Record<string, unknown>): PendingInputResponse | null {
  const { decision, answers, approved, action, feedback } = body
  if (decision === "allow" || decision === "allow_always" || decision === "deny") return { decision }
  if (typeof approved === "boolean") {
    return {
      approved,
      ...(typeof action === "string" && action ? { action } : {}),
      ...(typeof feedback === "string" && feedback ? { feedback } : {}),
    }
  }
  if (
    typeof answers === "string"
    || (Array.isArray(answers) && answers.every((answer) => typeof answer === "string"))
    || (typeof answers === "object" && answers !== null && !Array.isArray(answers)
      && Object.values(answers).every((answer) => typeof answer === "string"))
  ) {
    return { answers: answers as UserQuestionAnswers }
  }
  return null
}
