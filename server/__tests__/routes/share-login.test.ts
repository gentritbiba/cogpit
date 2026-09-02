// @vitest-environment node
/**
 * POST /api/share/verify — the only public endpoint in the share feature and
 * the only place a guest ever names a session.
 *
 * The registry and scrypt are real: the whole point of the endpoint is that a
 * passphrase the host handed out unlocks exactly one record, and that nothing
 * about the response distinguishes "no such share" from "wrong passphrase".
 */

import { Readable } from "node:stream"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const mockIsRateLimited = vi.hoisted(() => vi.fn(() => false))
const mockGetConfig = vi.hoisted(() => vi.fn())
const passwordVerify = vi.hoisted(() => ({
  verify: vi.fn(),
  actual: null as typeof import("../../password-verify") | null,
}))

vi.mock("../../config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config")>()),
  getConfig: mockGetConfig,
}))

vi.mock("../../lib/rateLimit", () => ({ isRateLimited: mockIsRateLimited }))

vi.mock("../../password-verify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../password-verify")>()
  passwordVerify.actual = actual
  return { ...actual, verifyRemotePassword: passwordVerify.verify }
})

import type { Middleware, UseFn } from "../../helpers"
import { getDummyHash } from "../../password-verify"
import { registerShareRoutes } from "../../routes/shares"
import { validateShareToken, __resetShareTokensForTest } from "../../security"
import {
  initShareRegistry,
  createShare,
  removeShare,
  rotateSharePassword,
} from "../../share/registry"

const SESSION_ID = "sess-1"
const OTHER_SESSION_ID = "sess-2"
const DIR_NAME = "-Users-me-proj"
const FILE_NAME = "sess-1.jsonl"
const UA = "Guest/1"

let registryRoot: string
let passphrase: string

function handler(): Middleware {
  const collected = new Map<string, Middleware>()
  const use: UseFn = (path, fn) => {
    collected.set(path, fn)
  }
  registerShareRoutes(use)
  const found = collected.get("/api/share/verify")
  if (!found) throw new Error("Route was not registered: /api/share/verify")
  return found
}

interface CallOptions {
  method?: string
  body?: unknown
  headers?: Record<string, string>
  https?: boolean
}

async function login(options: CallOptions = {}) {
  const headers: Record<string, string> = {
    host: "cogpit.example",
    "user-agent": UA,
    "x-cogpit-client": "1",
    ...options.headers,
  }
  const payload = Buffer.from(JSON.stringify(options.body ?? {}))
  const req = Object.assign(Readable.from([payload]), {
    method: options.method ?? "POST",
    url: "/",
    headers,
    // A browser login must be over HTTPS; the tunnel terminates TLS and
    // forwards, which is what x-forwarded-proto reports.
    socket: { remoteAddress: "203.0.113.5", encrypted: options.https !== false },
  }) as never

  let raw = ""
  const responseHeaders = new Map<string, string>()
  let settle: () => void = () => {}
  const finished = new Promise<void>((resolve) => {
    settle = resolve
  })
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader: (name: string, value: string) => {
      responseHeaders.set(name.toLowerCase(), value)
    },
    end: (data?: string) => {
      res.headersSent = true
      raw = data ?? ""
      settle()
    },
  }
  const next = vi.fn(() => settle())

  await handler()(req, res as never, next)
  await finished

  return {
    res,
    next,
    raw: () => raw,
    json: () => JSON.parse(raw) as Record<string, unknown>,
    cookie: () => responseHeaders.get("set-cookie") ?? null,
    shareToken: () => {
      const match = /__Host-cogpit_share=([^;]+)/.exec(responseHeaders.get("set-cookie") ?? "")
      return match?.[1] ?? null
    },
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  passwordVerify.verify.mockImplementation(passwordVerify.actual!.verifyRemotePassword)
  mockIsRateLimited.mockReturnValue(false)
  mockGetConfig.mockReturnValue({ networkAccess: true, networkPassword: "hashed" })
  registryRoot = await mkdtemp(join(tmpdir(), "cogpit-share-login-"))
  await initShareRegistry(registryRoot)
  __resetShareTokensForTest()
  passphrase = (await createShare({
    sessionId: SESSION_ID,
    dirName: DIR_NAME,
    fileName: FILE_NAME,
  })).passphrase
})

afterEach(async () => {
  await rm(registryRoot, { recursive: true, force: true })
})

describe("POST /api/share/verify", () => {
  it("issues a share cookie and never puts the token in the body", async () => {
    const result = await login({ body: { sessionId: SESSION_ID, passphrase } })

    expect(result.res.statusCode).toBe(200)
    expect(result.json()).toEqual({ valid: true })
    const token = result.shareToken()
    expect(token).toBeTruthy()
    expect(result.raw()).not.toContain(token)
    expect(validateShareToken(token!, UA)).toBe(SESSION_ID)
  })

  it("sets the share cookie and never the main session cookie", async () => {
    const result = await login({ body: { sessionId: SESSION_ID, passphrase } })

    const cookie = result.cookie()!
    expect(cookie).toContain("__Host-cogpit_share=")
    expect(cookie).not.toContain("__Host-cogpit_session=")
    expect(cookie).toContain("HttpOnly")
  })

  it("answers a wrong passphrase and an unknown share identically", async () => {
    const wrong = await login({ body: { sessionId: SESSION_ID, passphrase: "not-it" } })
    const unknown = await login({ body: { sessionId: "no-such-session", passphrase } })

    expect(wrong.res.statusCode).toBe(401)
    expect(unknown.res.statusCode).toBe(401)
    expect(unknown.raw()).toBe(wrong.raw())
    expect(wrong.json()).toEqual({ error: "Invalid link or passphrase" })
    expect(wrong.cookie()).toBeNull()
    expect(unknown.cookie()).toBeNull()
  })

  it("spends one scrypt derivation on an unknown share so timing cannot enumerate shares", async () => {
    await login({ body: { sessionId: "no-such-session", passphrase } })

    expect(passwordVerify.verify).toHaveBeenCalledTimes(1)
    expect(passwordVerify.verify).toHaveBeenCalledWith(passphrase, getDummyHash())
  })

  it("spends one scrypt derivation on a share that exists too", async () => {
    await login({ body: { sessionId: SESSION_ID, passphrase: "not-it" } })
    expect(passwordVerify.verify).toHaveBeenCalledTimes(1)
  })

  it("will not unlock one share with another share's passphrase", async () => {
    const other = await createShare({
      sessionId: OTHER_SESSION_ID,
      dirName: DIR_NAME,
      fileName: "sess-2.jsonl",
    })

    const result = await login({
      body: { sessionId: SESSION_ID, passphrase: other.passphrase },
    })

    expect(result.res.statusCode).toBe(401)
    expect(result.cookie()).toBeNull()
  })

  it("rate limits before spending any scrypt work", async () => {
    mockIsRateLimited.mockReturnValue(true)

    const result = await login({ body: { sessionId: SESSION_ID, passphrase } })

    expect(result.res.statusCode).toBe(429)
    expect(passwordVerify.verify).not.toHaveBeenCalled()
    expect(result.cookie()).toBeNull()
  })

  it("reports a saturated verifier separately from a bad passphrase", async () => {
    passwordVerify.verify.mockResolvedValue("busy")

    const result = await login({ body: { sessionId: SESSION_ID, passphrase } })

    expect(result.res.statusCode).toBe(429)
    expect(String(result.json().error)).toMatch(/busy/i)
    expect(result.cookie()).toBeNull()
  })

  it("refuses a browser login that is not over HTTPS", async () => {
    const result = await login({
      body: { sessionId: SESSION_ID, passphrase },
      https: false,
    })

    expect(result.res.statusCode).toBe(426)
    expect(String(result.json().error)).toMatch(/https/i)
    expect(String(result.json().error)).toMatch(/tunnel/i)
    expect(passwordVerify.verify).not.toHaveBeenCalled()
  })

  it("rejects a cross-site login attempt", async () => {
    const result = await login({
      body: { sessionId: SESSION_ID, passphrase },
      headers: { origin: "https://evil.example" },
    })

    expect(result.res.statusCode).toBe(403)
    expect(passwordVerify.verify).not.toHaveBeenCalled()
    expect(result.cookie()).toBeNull()
  })

  it("refuses to log a guest in while network access is off", async () => {
    mockGetConfig.mockReturnValue({ networkAccess: false, networkPassword: "hashed" })

    const result = await login({ body: { sessionId: SESSION_ID, passphrase } })

    expect(result.res.statusCode).toBe(403)
    expect(passwordVerify.verify).not.toHaveBeenCalled()
    expect(result.cookie()).toBeNull()
  })

  it("issues nothing when the passphrase is rotated during the derivation", async () => {
    passwordVerify.verify.mockImplementation(async (password: string, stored: string) => {
      // The host rotates while scrypt is still running. The handler is holding
      // a stale record, so it must re-read before minting anything.
      await rotateSharePassword(SESSION_ID)
      return passwordVerify.actual!.verifyRemotePassword(password, stored)
    })

    const result = await login({ body: { sessionId: SESSION_ID, passphrase } })

    expect(result.res.statusCode).toBe(401)
    expect(result.json()).toEqual({ error: "Invalid link or passphrase" })
    expect(result.cookie()).toBeNull()
  })

  it("issues nothing when the share is revoked during the derivation", async () => {
    passwordVerify.verify.mockImplementation(async (password: string, stored: string) => {
      await removeShare(SESSION_ID)
      return passwordVerify.actual!.verifyRemotePassword(password, stored)
    })

    const result = await login({ body: { sessionId: SESSION_ID, passphrase } })

    expect(result.res.statusCode).toBe(401)
    expect(result.cookie()).toBeNull()
  })

  it("rejects a missing or non-string passphrase without a cookie", async () => {
    for (const body of [
      { sessionId: SESSION_ID },
      { sessionId: SESSION_ID, passphrase: 42 },
      { sessionId: SESSION_ID, passphrase: null },
      { passphrase },
      {},
    ]) {
      const result = await login({ body })
      expect(result.res.statusCode, JSON.stringify(body)).toBe(401)
      expect(result.cookie()).toBeNull()
    }
  })

  it("hands a non-POST request back to the router", async () => {
    const result = await login({ method: "GET" })
    expect(result.next).toHaveBeenCalledOnce()
  })
})
