// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

vi.mock("../helpers", () => ({
  refreshDirs: vi.fn(),
  isTrustedDirectLocalRequest: vi.fn(),
  hasTrustedMutationSource: vi.fn(),
  canIssueBrowserSession: vi.fn(),
  isRateLimited: vi.fn(),
  createSessionToken: vi.fn(),
  getRequestSessionToken: vi.fn(),
  setBrowserSessionCookie: vi.fn(),
  clearBrowserSessionCookie: vi.fn(),
  revokeSessionToken: vi.fn(),
  verifyPasswordAsync: vi.fn(),
  needsPasswordRehash: vi.fn(),
  hashPassword: vi.fn(),
  validatePasswordStrength: vi.fn(),
  revokeAllSessions: vi.fn(),
  getConnectedDevices: vi.fn(),
}))

vi.mock("../config", () => ({
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
  validateClaudeDir: vi.fn(),
}))

import {
  isTrustedDirectLocalRequest,
  hasTrustedMutationSource,
  canIssueBrowserSession,
  isRateLimited,
  createSessionToken,
  setBrowserSessionCookie,
  verifyPasswordAsync,
  hashPassword,
} from "../helpers"
import { getConfig } from "../config"
import { initEdition, __resetEditionForTest } from "../team/edition"
import {
  initUsersStore,
  createUser,
  getUserByUsername,
  setUserDisabled,
  __resetUsersForTest,
} from "../team/users"

const mockedIsTrustedDirectLocalRequest = vi.mocked(isTrustedDirectLocalRequest)
const mockedHasTrustedMutationSource = vi.mocked(hasTrustedMutationSource)
const mockedCanIssueBrowserSession = vi.mocked(canIssueBrowserSession)
const mockedIsRateLimited = vi.mocked(isRateLimited)
const mockedCreateSessionToken = vi.mocked(createSessionToken)
const mockedSetBrowserSessionCookie = vi.mocked(setBrowserSessionCookie)
const mockedVerifyPasswordAsync = vi.mocked(verifyPasswordAsync)
const mockedHashPassword = vi.mocked(hashPassword)
const mockedGetConfig = vi.mocked(getConfig)

import type { UseFn, Middleware } from "../helpers"
import { asIncomingMessage, asServerResponse, getRouteHandler } from "./http-fixtures"
import { registerConfigRoutes } from "../routes/config"

const STRONG_PASSWORD = "correct-horse-battery-staple"
const originalEditionEnv = process.env.COGPIT_EDITION

function createMockReqRes(method: string, url: string, body?: string) {
  const dataHandlers: ((chunk: Buffer) => void)[] = []
  const endHandlers: (() => void)[] = []
  let endData = ""
  let statusCode = 200
  const headers: Record<string, string> = {}
  const req = {
    method,
    url,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === "data") dataHandlers.push(handler as (chunk: Buffer) => void)
      if (event === "end") endHandlers.push(handler as () => void)
      return req
    }),
    socket: {
      remoteAddress: "192.168.1.100",
      address: () => ({ port: 19384 }),
    },
    headers: {} as Record<string, string>,
  }
  const res = {
    get statusCode() { return statusCode },
    set statusCode(v: number) { statusCode = v },
    setHeader: vi.fn((name: string, value: string) => { headers[name] = value }),
    end: vi.fn((data?: string) => { endData = data || "" }),
    _getData: () => endData,
    _getStatus: () => statusCode,
  }
  const next = vi.fn()
  const sendBody = () => {
    if (body) {
      for (const h of dataHandlers) h(Buffer.from(body))
    }
    for (const h of endHandlers) h()
  }
  return { req: asIncomingMessage(req), res: asServerResponse(res), next, sendBody }
}

describe("POST /api/auth/verify (team edition)", () => {
  let root: string
  let handlers: Map<string, Middleware>
  let handler: Middleware

  beforeEach(async () => {
    vi.resetAllMocks()
    delete process.env.COGPIT_EDITION
    initEdition({ shell: "standalone", configEdition: "team" })
    root = await mkdtemp(join(tmpdir(), "cogpit-team-login-"))
    await initUsersStore(join(root, "team"))

    mockedIsTrustedDirectLocalRequest.mockReturnValue(false)
    mockedHasTrustedMutationSource.mockReturnValue(true)
    mockedCanIssueBrowserSession.mockReturnValue(true)
    mockedIsRateLimited.mockReturnValue(false)
    // A null config would make the personal path answer 403 "Network access is
    // disabled" — team logins must never consult it.
    mockedGetConfig.mockReturnValue(null)
    mockedHashPassword.mockReturnValue("dummy-timing-hash")
    mockedVerifyPasswordAsync.mockResolvedValue(false)

    handlers = new Map()
    const use: UseFn = (path: string, routeHandler: Middleware) => {
      handlers.set(path, routeHandler)
    }
    registerConfigRoutes(use)
    handler = getRouteHandler(handlers, "/api/auth/verify")
  })

  afterEach(async () => {
    __resetUsersForTest()
    __resetEditionForTest()
    if (originalEditionEnv === undefined) delete process.env.COGPIT_EDITION
    else process.env.COGPIT_EDITION = originalEditionEnv
    await rm(root, { recursive: true, force: true })
  })

  it("issues a browser cookie session for a JSON username login", async () => {
    const alice = await createUser({ username: "alice", password: STRONG_PASSWORD, role: "admin" })
    const body = JSON.stringify({ username: " Alice ", password: STRONG_PASSWORD })
    const { req, res, next, sendBody } = createMockReqRes("POST", "/", body)
    req.headers["x-cogpit-client"] = "1"
    req.headers["user-agent"] = "Browser/1"
    mockedVerifyPasswordAsync.mockResolvedValueOnce(true)
    mockedCreateSessionToken.mockReturnValueOnce("team-browser-session")

    const pending = handler(req, res, next)
    sendBody()
    await pending

    expect(mockedCreateSessionToken).toHaveBeenCalledWith(
      "192.168.1.100",
      "Browser/1",
      { userId: alice.id, username: "alice", role: "admin" },
    )
    expect(mockedSetBrowserSessionCookie).toHaveBeenCalledWith(res, "team-browser-session")
    expect(JSON.parse(res._getData())).toEqual({ valid: true })
    expect(mockedGetConfig).not.toHaveBeenCalled()
  })

  it("returns the session token in the body for a Bearer user:pass machine login", async () => {
    const alice = await createUser({ username: "alice", password: STRONG_PASSWORD, role: "member" })
    const { req, res, next } = createMockReqRes("POST", "/")
    req.headers.authorization = `Bearer alice:${STRONG_PASSWORD}`
    mockedVerifyPasswordAsync.mockResolvedValueOnce(true)
    mockedCreateSessionToken.mockReturnValueOnce("team-machine-session")

    await handler(req, res, next)

    expect(mockedVerifyPasswordAsync).toHaveBeenCalledWith(
      STRONG_PASSWORD,
      getUserByUsername("alice")!.passwordHash,
    )
    expect(mockedCreateSessionToken).toHaveBeenCalledWith(
      "192.168.1.100",
      undefined,
      { userId: alice.id, username: "alice", role: "member" },
    )
    expect(JSON.parse(res._getData())).toEqual({ valid: true, token: "team-machine-session" })
  })

  it("splits Bearer credentials at the first colon only", async () => {
    await createUser({ username: "alice", password: STRONG_PASSWORD, role: "admin" })
    const { req, res, next } = createMockReqRes("POST", "/")
    req.headers.authorization = "Bearer alice:pass:with:colons"
    mockedVerifyPasswordAsync.mockResolvedValueOnce(true)
    mockedCreateSessionToken.mockReturnValueOnce("session")

    await handler(req, res, next)

    expect(mockedVerifyPasswordAsync).toHaveBeenCalledWith(
      "pass:with:colons",
      getUserByUsername("alice")!.passwordHash,
    )
  })

  it("rejects a bad password with 401 Invalid credentials", async () => {
    await createUser({ username: "alice", password: STRONG_PASSWORD, role: "admin" })
    const { req, res, next } = createMockReqRes("POST", "/")
    req.headers.authorization = "Bearer alice:wrong-password-guess"
    mockedVerifyPasswordAsync.mockResolvedValueOnce(false)

    await handler(req, res, next)

    expect(res._getStatus()).toBe(401)
    expect(JSON.parse(res._getData())).toEqual({ valid: false, error: "Invalid credentials" })
    expect(mockedCreateSessionToken).not.toHaveBeenCalled()
  })

  it("verifies unknown users against a dummy hash so timing cannot enumerate accounts", async () => {
    await createUser({ username: "alice", password: STRONG_PASSWORD, role: "admin" })
    const { req, res, next } = createMockReqRes("POST", "/")
    req.headers.authorization = "Bearer mallory:some-password-guess"
    // The dummy result must be ignored even if the scrypt comparison "passes".
    mockedVerifyPasswordAsync.mockResolvedValueOnce(true)

    await handler(req, res, next)

    expect(mockedVerifyPasswordAsync).toHaveBeenCalledWith("some-password-guess", "dummy-timing-hash")
    expect(res._getStatus()).toBe(401)
    expect(JSON.parse(res._getData())).toEqual({ valid: false, error: "Invalid credentials" })
  })

  it("rejects a disabled account with 403 after password verification succeeds", async () => {
    await createUser({ username: "alice", password: STRONG_PASSWORD, role: "admin" })
    const bob = await createUser({ username: "bob", password: STRONG_PASSWORD, role: "member" })
    await setUserDisabled(bob.id, true)
    const { req, res, next } = createMockReqRes("POST", "/")
    req.headers.authorization = `Bearer bob:${STRONG_PASSWORD}`
    mockedVerifyPasswordAsync.mockResolvedValueOnce(true)

    await handler(req, res, next)

    expect(res._getStatus()).toBe(403)
    expect(JSON.parse(res._getData())).toEqual({ valid: false, error: "Account disabled" })
    expect(mockedCreateSessionToken).not.toHaveBeenCalled()
  })

  it("does not reveal disabled status on a wrong password", async () => {
    await createUser({ username: "alice", password: STRONG_PASSWORD, role: "admin" })
    const bob = await createUser({ username: "bob", password: STRONG_PASSWORD, role: "member" })
    await setUserDisabled(bob.id, true)
    const { req, res, next } = createMockReqRes("POST", "/")
    req.headers.authorization = "Bearer bob:wrong-password-guess"
    mockedVerifyPasswordAsync.mockResolvedValueOnce(false)

    await handler(req, res, next)

    expect(res._getStatus()).toBe(401)
    expect(JSON.parse(res._getData())).toEqual({ valid: false, error: "Invalid credentials" })
  })

  it("rejects a bare Bearer password (no colon) with 401 Username required", async () => {
    const { req, res, next } = createMockReqRes("POST", "/")
    req.headers.authorization = "Bearer just-a-network-password"

    await handler(req, res, next)

    expect(res._getStatus()).toBe(401)
    expect(JSON.parse(res._getData())).toEqual({ valid: false, error: "Username required" })
    expect(mockedVerifyPasswordAsync).not.toHaveBeenCalled()
  })

  it("requires a password when the JSON body omits it", async () => {
    const body = JSON.stringify({ username: "alice" })
    const { req, res, next, sendBody } = createMockReqRes("POST", "/", body)

    const pending = handler(req, res, next)
    sendBody()
    await pending

    expect(res._getStatus()).toBe(401)
    expect(JSON.parse(res._getData())).toEqual({ valid: false, error: "Password required" })
  })

  it("does not grant the trusted-local bypass in team edition", async () => {
    mockedIsTrustedDirectLocalRequest.mockReturnValue(true)
    const { req, res, next, sendBody } = createMockReqRes("POST", "/")

    const pending = handler(req, res, next)
    sendBody()
    await pending

    expect(res._getStatus()).toBe(401)
    expect(JSON.parse(res._getData())).toEqual({ valid: false, error: "Username required" })
  })

  it("still applies the rate limit", async () => {
    mockedIsRateLimited.mockReturnValueOnce(true)
    const { req, res, next } = createMockReqRes("POST", "/")

    await handler(req, res, next)

    expect(res._getStatus()).toBe(429)
    expect(JSON.parse(res._getData()).valid).toBe(false)
  })

  it("still rejects untrusted mutation sources", async () => {
    mockedHasTrustedMutationSource.mockReturnValueOnce(false)
    const { req, res, next } = createMockReqRes("POST", "/")

    await handler(req, res, next)

    expect(res._getStatus()).toBe(403)
    expect(JSON.parse(res._getData()).error).toContain("Untrusted request source")
  })

  it("caps concurrent scrypt verifications for user logins too", async () => {
    await createUser({ username: "alice", password: STRONG_PASSWORD, role: "admin" })
    let resolveVerification!: (valid: boolean) => void
    const pendingVerification = new Promise<boolean>((resolve) => {
      resolveVerification = resolve
    })
    mockedVerifyPasswordAsync.mockReturnValue(pendingVerification)

    const attempts = Array.from({ length: 3 }, () => {
      const attempt = createMockReqRes("POST", "/")
      attempt.req.headers.authorization = `Bearer alice:${STRONG_PASSWORD}`
      return attempt
    })
    const first = handler(attempts[0].req, attempts[0].res, attempts[0].next)
    const second = handler(attempts[1].req, attempts[1].res, attempts[1].next)
    await handler(attempts[2].req, attempts[2].res, attempts[2].next)

    expect(attempts[2].res._getStatus()).toBe(429)
    expect(JSON.parse(attempts[2].res._getData()).error).toContain("busy")

    resolveVerification(false)
    await Promise.all([first, second])
    expect(attempts[0].res._getStatus()).toBe(401)
    expect(attempts[1].res._getStatus()).toBe(401)
  })
})
