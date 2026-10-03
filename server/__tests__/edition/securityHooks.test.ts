// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import type { IncomingMessage } from "node:http"

import { __resetEditionForTest, type SocketTransport } from "../../edition"
import { getRequestAuthentication, setRequestAuthentication, type RequestAuthentication } from "../../requestAuthentication"
import {
  __resetSessionsForTest,
  authMiddleware,
  createSessionToken,
  flushPersistentSessions,
  getSessionPrincipal,
  revokeAllSessions,
  revokeSessionsForPrincipal,
  revokeSessionToken,
  trackAuthenticatedHttpStream,
  validateSessionToken,
  websocketUpgradeRejection,
} from "../../security"
import { SESSION_ABSOLUTE_TTL_MS, SESSION_IDLE_TTL_MS, type SessionPrincipal } from "../../sessionConstants"
import { asServerResponse, createMiddlewareRes } from "../http-fixtures"
import { fakeEditionAuth } from "./fakeAuth"
import { installFakeEdition } from "./fakeEdition"

/** security.ts's half of the edition seam: sign-in handoff, persisted logins and stream access. */

const ALICE: SessionPrincipal = { userId: "u_alice", username: "alice", role: "member" }
const BOB: SessionPrincipal = { userId: "u_bob", username: "bob", role: "admin" }
const UA = "Browser/1"

function request(url: string, { ip = "192.168.1.100", method = "GET" } = {}): IncomingMessage {
  const host = ip === "127.0.0.1" ? "127.0.0.1:19384" : "cogpit.local:19384"
  return { url, method, socket: { remoteAddress: ip }, headers: { host } } as unknown as IncomingMessage
}

/** Restart the process as far as logins go: only what the edition persisted survives. */
const restart = () => __resetSessionsForTest()

afterEach(() => {
  vi.useRealTimers()
  __resetSessionsForTest()
  __resetEditionForTest()
})

describe("sign-in handoff", () => {
  it.each([
    ["a remote request", request("/api/projects")],
    ["a trusted local request", request("/api/projects", { ip: "127.0.0.1" })],
    ["a public path", request("/api/hello")],
  ])("gives %s to the edition's middleware alone, with no authentication carried over", (_name, req) => {
    const auth = fakeEditionAuth()
    let carried: RequestAuthentication | null | undefined
    auth.middleware.mockImplementation((seen: IncomingMessage) => { carried = getRequestAuthentication(seen) })
    installFakeEdition({ auth })
    setRequestAuthentication(req, { kind: "local" })
    const response = createMiddlewareRes()
    const next = vi.fn()

    authMiddleware(req, response.res, next)

    expect(auth.middleware).toHaveBeenCalledExactlyOnceWith(req, response.res, next)
    expect(carried).toBeNull()
    expect(next).not.toHaveBeenCalled()
    expect(response.body).toBe("")
  })
})

describe("persisted logins", () => {
  let auth: ReturnType<typeof fakeEditionAuth>
  const store = () => auth.sessions

  beforeEach(() => {
    auth = fakeEditionAuth()
    installFakeEdition({ auth })
  })

  it("persists a login that names a user, and no other", () => {
    const token = createSessionToken("10.0.0.1", UA, ALICE)
    createSessionToken("10.0.0.1", UA)

    expect(store().persist).toHaveBeenCalledExactlyOnceWith(token, ALICE, expect.any(Number))
  })

  it("restores a persisted login after a restart, with the principal the edition read back", () => {
    const token = createSessionToken("10.0.0.1", UA, ALICE)
    store().rows.set(token, { ...store().rows.get(token)!, principal: BOB })
    restart()

    expect(validateSessionToken(token, UA)).toBe(true)
    expect(getSessionPrincipal(token)).toEqual(BOB)
    expect(store().restore).toHaveBeenCalledExactlyOnceWith(token)
  })

  it.each([
    ["its user is gone or disabled", () => ({ createdAt: Date.now(), lastActivity: Date.now(), principal: null })],
    ["it outlived the absolute TTL", () => ({ createdAt: Date.now() - SESSION_ABSOLUTE_TTL_MS - 1, lastActivity: Date.now(), principal: ALICE })],
    ["it sat idle past the idle TTL", () => ({ createdAt: Date.now(), lastActivity: Date.now() - SESSION_IDLE_TTL_MS - 1, principal: ALICE })],
  ])("discards and removes a persisted login when %s", (_reason, row) => {
    store().rows.set("persisted-token", row())

    expect(validateSessionToken("persisted-token", UA)).toBe(false)
    expect(getSessionPrincipal("persisted-token")).toBeNull()
    expect(store().remove).toHaveBeenCalledWith("persisted-token")
    expect(store().rows.has("persisted-token")).toBe(false)
  })

  it("records a login's activity, but not on every request", () => {
    vi.useFakeTimers()
    const token = createSessionToken("10.0.0.1", UA, ALICE)
    expect(validateSessionToken(token, UA)).toBe(true)
    expect(store().touch).not.toHaveBeenCalled()

    vi.advanceTimersByTime(SESSION_IDLE_TTL_MS / 2)
    validateSessionToken(token, UA)
    validateSessionToken(token, UA)

    expect(store().touch).toHaveBeenCalledExactlyOnceWith(token, Date.now())
  })

  it("never touches a login that names no user", () => {
    vi.useFakeTimers()
    const token = createSessionToken("10.0.0.1", UA)
    vi.advanceTimersByTime(SESSION_IDLE_TTL_MS / 2)

    expect(validateSessionToken(token, UA)).toBe(true)
    expect(store().touch).not.toHaveBeenCalled()
  })

  it("removes a revoked token, a user's tokens, or every token from the store", async () => {
    const aliceToken = createSessionToken("10.0.0.1", UA, ALICE)
    const bobToken = createSessionToken("10.0.0.1", UA, BOB)

    await revokeSessionToken(aliceToken)
    expect(store().remove).toHaveBeenCalledWith(aliceToken)
    await revokeSessionsForPrincipal(BOB.userId)
    expect(store().removeForUser).toHaveBeenCalledExactlyOnceWith(BOB.userId)
    expect(validateSessionToken(bobToken, UA)).toBe(false)
    await revokeAllSessions()
    expect(store().clear).toHaveBeenCalledOnce()
  })

  it("flushes the edition's store", async () => {
    await flushPersistentSessions()
    expect(store().flush).toHaveBeenCalledOnce()
  })

  it("keeps logins in memory only in personal edition", () => {
    __resetEditionForTest()
    const token = createSessionToken("10.0.0.1", UA, ALICE)
    expect(getSessionPrincipal(token)).toEqual(ALICE)
    restart()

    expect(validateSessionToken(token, UA)).toBe(false)
    expect(store().persist).not.toHaveBeenCalled()
    expect(store().restore).not.toHaveBeenCalled()
  })
})

describe("stream access binding", () => {
  const streamResponse = () => asServerResponse(Object.assign(new EventEmitter(), { writableEnded: false, destroy: vi.fn() }))

  function accessBinder() {
    const access = { recheck: vi.fn(), unbind: vi.fn() }
    return { access, bind: vi.fn(() => access) }
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  it.each([
    ["an ordinary GET", request("/api/projects")],
    ["a stream path under POST", request("/api/watch/project/session.jsonl", { method: "POST" })],
  ])("binds nothing for %s", (_name, req) => {
    const { bind } = accessBinder()
    trackAuthenticatedHttpStream(req, streamResponse(), createSessionToken("10.0.0.1"), bind)
    expect(bind).not.toHaveBeenCalled()
  })

  it("binds a stream, rechecks it on the interval, and unbinds it once it closes", () => {
    const { access, bind } = accessBinder()
    const res = streamResponse()
    trackAuthenticatedHttpStream(request("/hub/dev_1/api/watch/project/session.jsonl"), res, createSessionToken("10.0.0.1"), bind)
    expect(bind).toHaveBeenCalledOnce()

    vi.advanceTimersByTime(5_000)
    expect(access.recheck).toHaveBeenCalledOnce()

    res.emit("close")
    res.emit("finish")
    vi.advanceTimersByTime(10_000)
    expect(access.unbind).toHaveBeenCalledOnce()
    expect(access.recheck).toHaveBeenCalledOnce()
  })

  it("unbinds and ends a stream whose token is revoked", async () => {
    const { access, bind } = accessBinder()
    const res = streamResponse()
    const token = createSessionToken("10.0.0.1")
    trackAuthenticatedHttpStream(request("/api/task-output?sessionId=s"), res, token, bind)

    await revokeSessionToken(token)

    expect(access.unbind).toHaveBeenCalledOnce()
    expect(res.destroy).toHaveBeenCalledOnce()
  })
})

describe("socket admission", () => {
  function upgrade(token: string, path = "/__pty") {
    const req = { socket: { remoteAddress: "192.168.1.100" }, headers: { host: "cogpit.local:19384" } } as unknown as IncomingMessage
    return websocketUpgradeRejection(req, new URL(`http://cogpit.local${path}?token=${token}`))
  }

  it("lets the edition decide who holds a socket, asking with the token's principal", () => {
    const auth = fakeEditionAuth()
    installFakeEdition({ auth })

    expect(upgrade(createSessionToken("192.168.1.100", undefined, BOB))).toBeNull()
    expect(auth.admitsSocket).toHaveBeenCalledWith(BOB, "terminal")

    auth.admitsSocket.mockReturnValue(false)
    expect(upgrade(createSessionToken("192.168.1.100", undefined, BOB))).toBe(403)
  })

  it("tells the edition a browser viewer apart from the terminal", () => {
    const auth = fakeEditionAuth()
    installFakeEdition({ auth })

    expect(upgrade(createSessionToken("192.168.1.100", undefined, BOB), "/__browser")).toBeNull()
    expect(auth.admitsSocket).toHaveBeenCalledWith(BOB, "browser")
  })

  it("refuses a member a hub device's browser viewer, which reaches the whole device", () => {
    const auth = {
      ...fakeEditionAuth(),
      admitsSocket: vi.fn((principal: SessionPrincipal, transport: SocketTransport) =>
        transport === "browser" || principal.role === "admin"),
    }
    installFakeEdition({ auth })

    expect(upgrade(createSessionToken("192.168.1.100", undefined, ALICE), "/hub/dev-1/__browser")).toBe(403)
    expect(auth.admitsSocket).toHaveBeenCalledWith(ALICE, "terminal")
    expect(upgrade(createSessionToken("192.168.1.100", undefined, ALICE), "/__browser")).toBeNull()
    expect(upgrade(createSessionToken("192.168.1.100", undefined, BOB), "/hub/dev-1/__browser")).toBeNull()
  })

  it("refuses a token that names no user without asking the edition", () => {
    const auth = fakeEditionAuth()
    installFakeEdition({ auth })

    expect(upgrade(createSessionToken("192.168.1.100"))).toBe(403)
    expect(auth.admitsSocket).not.toHaveBeenCalled()
  })
})
