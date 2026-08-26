import type { IncomingMessage, ServerResponse } from "node:http"
import { Readable } from "node:stream"
import { isCodexDirName } from "../helpers"
import { MAX_REQUEST_BODY_BYTES, sendJson, withJsonBody, type Middleware, type UseFn } from "../http"
import { getRequestShareToken, validateShareToken } from "../security"
import { getShareWithHash, type ShareRecord } from "../share/registry"
import { sessionTitle } from "./shares"
import { registerAskUserRoutes } from "./ask-user"
import { registerClaudeManageRoutes } from "./claude-manage"
import { registerClaudeRoutes } from "./claude"
import { collectPendingPermissions, registerPermissionRoutes } from "./permissions"
import { getSDKUserQuestions } from "../sdk-session"

/**
 * Everything a share guest can do that changes something.
 *
 * The URL-keyed reads keep their real paths (the allowlist checks those against
 * the share record), but a mutation has nothing in the request to check a
 * session against — so these endpoints carry no session at all. The sessionId
 * comes from the share token and the request body is never consulted for one,
 * even if it contains one.
 *
 * Each endpoint hands the delegated call to the real host handler rather than
 * reimplementing it. A second copy of "resume this session" is a second place
 * to fix every bug.
 */

/** The handlers a host route module mounts, keyed by mount path. */
function mounts(register: (use: UseFn) => void): (path: string) => Middleware {
  const collected = new Map<string, Middleware>()
  register((path, handler) => {
    collected.set(path, handler)
  })
  return (path) => {
    const handler = collected.get(path)
    if (!handler) throw new Error(`Share guest delegation target is not mounted: ${path}`)
    return handler
  }
}

/**
 * Replay a request into a host handler with a body this route composed.
 *
 * The guest's own headers are not forwarded: the delegated handlers read a JSON
 * body, and passing the share cookie along would put a guest credential on a
 * request that runs past the guest boundary.
 */
function delegate(
  handler: Middleware,
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  payload: Record<string, unknown>,
): void {
  const body = Buffer.from(JSON.stringify(payload))
  const delegated = Object.assign(Readable.from([body]), {
    method: "POST",
    url,
    headers: {
      host: req.headers.host,
      "content-type": "application/json",
      "content-length": String(body.byteLength),
    },
    socket: req.socket,
  }) as unknown as IncomingMessage

  const notFound = () => sendJson(res, 404, { error: "Not found" })
  void Promise.resolve(handler(delegated, res, notFound)).catch(() => {
    if (!res.headersSent) sendJson(res, 500, { error: "Request failed" })
  })
}

/**
 * The share this request belongs to, or null once it has answered 401.
 *
 * The middleware already validated the token, but it validated it before the
 * body was read: a token that expires or is revoked during a request must fail
 * closed, and the mount is reachable by a host session the share branch never
 * looked at.
 */
function requireShare(req: IncomingMessage, res: ServerResponse): ShareRecord | null {
  const token = getRequestShareToken(req)
  const sessionId = token ? validateShareToken(token, req.headers["user-agent"] ?? "") : null
  const share = sessionId ? getShareWithHash(sessionId) : undefined
  if (!share) {
    sendJson(res, 401, { error: "Share authentication required" })
    return null
  }
  return share
}

function optionalString(body: unknown, key: string): string | undefined {
  const value = (body as Record<string, unknown> | null | undefined)?.[key]
  return typeof value === "string" ? value : undefined
}

/** POST endpoint that reads the guest body and delegates it under the token's session. */
function guestPost(
  use: UseFn,
  path: string,
  build: (share: ShareRecord, body: Record<string, unknown>) => {
    handler: Middleware
    url: string
    payload: Record<string, unknown>
  },
  maxBytes?: number,
): void {
  use(path, (req, res, next) => {
    if (req.method !== "POST") return next()
    if (!requireShare(req, res)) return
    withJsonBody<Record<string, unknown>>(req, res, (body) => {
      // Checked again on the far side of the body read: a token that expires or
      // is revoked while the request is still arriving must fail closed.
      const share = requireShare(req, res)
      if (!share) return
      const call = build(share, body ?? {})
      delegate(call.handler, req, res, call.url, call.payload)
    }, { allowEmpty: true, maxBytes })
  })
}

export function registerShareGuestRoutes(use: UseFn) {
  const claudeManage = mounts(registerClaudeManageRoutes)
  const sendMessage = mounts(registerClaudeRoutes)("/api/send-message")
  const stop = claudeManage("/api/stop-session")
  const interrupt = claudeManage("/api/interrupt-session")
  const permissions = mounts(registerPermissionRoutes)("/api/permissions")
  const answer = mounts(registerAskUserRoutes)("/api/ask-user-answer")

  use("/api/share/session", async (req, res, next) => {
    if (req.method !== "GET") return next()
    const share = requireShare(req, res)
    if (!share) return
    sendJson(res, 200, {
      sessionId: share.sessionId,
      dirName: share.dirName,
      fileName: share.fileName,
      title: await sessionTitle(share.dirName, share.fileName),
      provider: isCodexDirName(share.dirName) ? "codex" : "claude",
    })
  })

  // A guest may answer a permission request and an AskUserQuestion, so it has
  // to be able to see them. Neither host read is on the allowlist, the
  // transcript stream carries only lines, and session-status carries no
  // permission data — so both are served here, from the same sources the host
  // routes read, under the token's session and no other. One endpoint rather
  // than two mirrored ones: the guest polls both on the same tick, and that is
  // one round trip over the tunnel instead of two.
  use("/api/share/pending", (req, res, next) => {
    if (req.method !== "GET") return next()
    const share = requireShare(req, res)
    if (!share) return
    sendJson(res, 200, {
      permissions: collectPendingPermissions(share.sessionId),
      questions: getSDKUserQuestions(share.sessionId),
    })
  })

  // Only the message itself crosses over. cwd, mcpConfig and permissions would
  // let a guest run a command of their choosing outside the shared session.
  // The body cap matches what /api/send-message itself accepts, so a pasted
  // image is not silently rejected for guests alone.
  guestPost(use, "/api/share/send-message", (share, body) => ({
    handler: sendMessage,
    url: "/",
    payload: {
      sessionId: share.sessionId,
      message: body.message,
      images: body.images,
    },
  }), MAX_REQUEST_BODY_BYTES)

  guestPost(use, "/api/share/stop", (share) => ({
    handler: stop,
    url: "/",
    payload: { sessionId: share.sessionId },
  }))

  guestPost(use, "/api/share/interrupt", (share) => ({
    handler: interrupt,
    url: "/",
    payload: { sessionId: share.sessionId },
  }))

  // The permission route names its session in the path, so the token's session
  // goes there instead of in the body.
  guestPost(use, "/api/share/permission", (share, body) => ({
    handler: permissions,
    url: `/${encodeURIComponent(share.sessionId)}/respond`,
    payload: {
      requestId: optionalString(body, "requestId"),
      behavior: optionalString(body, "behavior"),
    },
  }))

  guestPost(use, "/api/share/answer", (share, body) => ({
    handler: answer,
    url: "/",
    payload: {
      sessionId: share.sessionId,
      toolUseId: optionalString(body, "toolUseId"),
      answers: body.answers,
    },
  }))
}
