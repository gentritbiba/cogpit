import type { IncomingMessage } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type { SignInMode } from "../../../shared/contracts/identity"
import { getConfig } from "../../config"
import { __resetEditionForTest } from "../../edition"
import { getRequestPrincipal } from "../../requestPrincipal"
import {
  authMiddleware,
  countShareGuests,
  createSessionToken,
  createShareToken,
  websocketUpgradeRejection,
  __resetSessionsForTest,
  __resetShareTokensForTest,
  type SessionPrincipal,
} from "../../security"
import { createShare, initShareRegistry, removeShare } from "../../share/registry"
import { isShareGuestRequest } from "../../share/requestGuest"
import { createMiddlewareRes } from "../http-fixtures"

/**
 * The share guest branch of authMiddleware, for a test file that mocks
 * `server/config` (`vi.mock` must sit in the test file itself).
 */

export const mockedGetConfig = vi.mocked(getConfig)

export const SESSION_ID = "sess-1"
export const DIR_NAME = "-Users-me-proj"
export const FILE_NAME = "sess-1.jsonl"
export const UA = "Guest/1"
export const GUEST_IP = "203.0.113.5"
export const HOST = "cogpit.example"

export const ADMIN: SessionPrincipal = { userId: "u1", username: "admin", role: "admin" }

const originalEditionEnv = process.env.COGPIT_EDITION

let registryRoot: string

interface RequestOptions {
  ip?: string
  host?: string
  method?: string
  shareCookie?: string
  sessionCookie?: string
  authHeader?: string
  userAgent?: string
  origin?: string
  fetchSite?: string
}

export function mockReq(url: string, opts: RequestOptions = {}): IncomingMessage {
  const headers: Record<string, string> = { host: opts.host ?? HOST }
  const cookies: string[] = []
  if (opts.shareCookie) cookies.push(`__Host-cogpit_share=${opts.shareCookie}`)
  if (opts.sessionCookie) cookies.push(`__Host-cogpit_session=${opts.sessionCookie}`)
  if (cookies.length) headers.cookie = cookies.join("; ")
  if (opts.authHeader) headers.authorization = opts.authHeader
  if (opts.userAgent !== undefined) headers["user-agent"] = opts.userAgent
  if (opts.origin) headers.origin = opts.origin
  if (opts.fetchSite) headers["sec-fetch-site"] = opts.fetchSite
  return {
    socket: { remoteAddress: opts.ip ?? GUEST_IP },
    url,
    method: opts.method ?? "GET",
    headers,
  } as unknown as IncomingMessage
}

export function run(url: string, opts: RequestOptions = {}) {
  const req = mockReq(url, opts)
  const mock = createMiddlewareRes()
  const next = vi.fn()
  authMiddleware(req, mock.res, next)
  return { req, res: mock.res, next, get statusCode() { return mock.statusCode }, get body() { return mock.body } }
}

/** A guest cookie for the shared session, pinned to the default UA. */
export function guestCookie(ip = GUEST_IP): string {
  return createShareToken(SESSION_ID, ip, UA)
}

/** The share registry holding the one shared session, and clean token maps around every test. */
export function useShareAuthFixture(): void {
  beforeAll(async () => {
    registryRoot = await mkdtemp(join(tmpdir(), "cogpit-share-auth-"))
    await initShareRegistry(registryRoot)
    await createShare({ sessionId: SESSION_ID, dirName: DIR_NAME, fileName: FILE_NAME })
  })

  afterAll(async () => {
    await rm(registryRoot, { recursive: true, force: true })
  })

  beforeEach(() => {
    delete process.env.COGPIT_EDITION
    mockedGetConfig.mockReturnValue({ networkAccess: true, networkPassword: "hashed" } as never)
    __resetShareTokensForTest()
    __resetSessionsForTest()
  })

  afterEach(() => {
    __resetEditionForTest()
    if (originalEditionEnv === undefined) delete process.env.COGPIT_EDITION
    else process.env.COGPIT_EDITION = originalEditionEnv
  })
}

/**
 * Every case that must hold identically however the server signs in. An
 * edition that signs accounts in trusts nothing — loopback included — so a
 * divergence here means one grew a guest-reachable path the other does not have.
 */
export function describeSharedBranch(signIn: SignInMode, enter?: () => void): void {
  describe(`share branch with ${signIn} sign-in`, () => {
    if (enter) beforeEach(enter)

    it("admits an allowlisted request carrying a valid share cookie", () => {
      const r = run(`/api/session-status/${SESSION_ID}`, {
        shareCookie: guestCookie(),
        userAgent: UA,
      })
      expect(r.next).toHaveBeenCalledOnce()
      expect(r.statusCode).toBe(200)
    })

    it("admits the shared session's transcript stream", () => {
      const r = run(`/api/watch/${DIR_NAME}/${FILE_NAME}`, {
        shareCookie: guestCookie(),
        userAgent: UA,
      })
      expect(r.next).toHaveBeenCalledOnce()
    })

    it("403s a non-allowlisted request rather than falling through", () => {
      const r = run("/api/projects", { shareCookie: guestCookie(), userAgent: UA })
      expect(r.next).not.toHaveBeenCalled()
      expect(r.statusCode).toBe(403)
      expect(r.body).toContain("Not available on a shared session")
    })

    it("403s a cross-session request", () => {
      const r = run("/api/session-status/sess-2", { shareCookie: guestCookie(), userAgent: UA })
      expect(r.next).not.toHaveBeenCalled()
      expect(r.statusCode).toBe(403)
    })

    it("403s another session's transcript stream", () => {
      const r = run(`/api/watch/${DIR_NAME}/other.jsonl`, {
        shareCookie: guestCookie(),
        userAgent: UA,
      })
      expect(r.next).not.toHaveBeenCalled()
      expect(r.statusCode).toBe(403)
    })

    // THE escalation test. A guest whose traffic reaches the server over
    // loopback — a tunnel terminating locally, or a browser on the host — must
    // not be handed the app by the local-trust shortcut.
    it("does not grant full access to a share cookie arriving on trusted loopback", () => {
      const r = run("/api/projects", {
        ip: "127.0.0.1",
        host: "localhost",
        shareCookie: guestCookie("127.0.0.1"),
        userAgent: UA,
      })
      expect(r.next).not.toHaveBeenCalled()
      expect(r.statusCode).toBe(403)
    })

    it("403s a loopback share cookie on a mutation the host could otherwise run", () => {
      const r = run("/api/send-message", {
        ip: "127.0.0.1",
        host: "localhost",
        method: "POST",
        shareCookie: guestCookie("127.0.0.1"),
        userAgent: UA,
        origin: "http://localhost",
      })
      expect(r.next).not.toHaveBeenCalled()
      expect(r.statusCode).toBe(403)
    })

    it("401s an expired or unknown share cookie", () => {
      const r = run(`/api/session-status/${SESSION_ID}`, {
        shareCookie: "deadbeef",
        userAgent: UA,
      })
      expect(r.next).not.toHaveBeenCalled()
      expect(r.statusCode).toBe(401)
      expect(r.body).toContain("Share authentication required")
    })

    it("401s a share cookie whose registry record was deleted", async () => {
      await createShare({ sessionId: "sess-gone", dirName: DIR_NAME, fileName: "gone.jsonl" })
      const token = createShareToken("sess-gone", GUEST_IP, UA)
      await removeShare("sess-gone")

      const r = run("/api/session-status/sess-gone", { shareCookie: token, userAgent: UA })
      expect(r.next).not.toHaveBeenCalled()
      expect(r.statusCode).toBe(401)

      // The token is dropped too, not merely refused: leaving it in the map
      // would keep the revoked guest in the host's live guest count until the
      // idle TTL expired it.
      expect(countShareGuests("sess-gone")).toBe(0)
    })

    it("401s a share cookie presented by a different user agent", () => {
      const token = guestCookie()
      const r = run(`/api/session-status/${SESSION_ID}`, {
        shareCookie: token,
        userAgent: "Attacker/9",
      })
      expect(r.next).not.toHaveBeenCalled()
      expect(r.statusCode).toBe(401)
    })

    it("marks an admitted guest for the authz layer, and as no principal", () => {
      // The edition's authz middleware runs next and may refuse anything it
      // cannot account for. A guest carries no SessionPrincipal and never
      // will, so it has to arrive there labelled as what it is.
      const r = run(`/api/session-status/${SESSION_ID}`, {
        shareCookie: guestCookie(),
        userAgent: UA,
      })
      expect(r.next).toHaveBeenCalledOnce()
      expect(isShareGuestRequest(r.req)).toBe(true)
      expect(getRequestPrincipal(r.req)).toBeNull()
    })

    it("does not mark a request the guest branch refused", () => {
      const r = run("/api/projects", { shareCookie: guestCookie(), userAgent: UA })
      expect(r.statusCode).toBe(403)
      expect(isShareGuestRequest(r.req)).toBe(false)
    })

    it("401s a share cookie replayed with no user agent at all", () => {
      // curl holding a stolen browser cookie. An absent header is a client
      // that does not match the browser the token was minted for, so it is a
      // mismatch — not a reason to skip the pin.
      const r = run(`/api/session-status/${SESSION_ID}`, { shareCookie: guestCookie() })
      expect(r.next).not.toHaveBeenCalled()
      expect(r.statusCode).toBe(401)
    })

    it("requires a trusted mutation source for share mutations", () => {
      const r = run("/api/share/send-message", {
        method: "POST",
        shareCookie: guestCookie(),
        userAgent: UA,
        origin: "https://evil.example",
      })
      expect(r.next).not.toHaveBeenCalled()
      expect(r.statusCode).toBe(403)
      expect(r.body).toContain("Untrusted request source")
    })

    it("rejects a mutation whose Sec-Fetch-Site says cross-site", () => {
      const r = run("/api/share/send-message", {
        method: "POST",
        shareCookie: guestCookie(),
        userAgent: UA,
        fetchSite: "cross-site",
      })
      expect(r.next).not.toHaveBeenCalled()
      expect(r.statusCode).toBe(403)
    })

    it("admits a same-origin share mutation", () => {
      const r = run("/api/share/send-message", {
        method: "POST",
        shareCookie: guestCookie(),
        userAgent: UA,
        origin: `http://${HOST}`,
      })
      expect(r.next).toHaveBeenCalledOnce()
    })

    it("403s a same-origin mutation that is not in the share namespace", () => {
      const r = run("/api/send-message", {
        method: "POST",
        shareCookie: guestCookie(),
        userAgent: UA,
        origin: `http://${HOST}`,
      })
      expect(r.next).not.toHaveBeenCalled()
      expect(r.statusCode).toBe(403)
    })

    it("does not let a bearer header push a guest onto the full-access path", () => {
      const r = run("/api/projects", {
        ip: "127.0.0.1",
        host: "localhost",
        shareCookie: guestCookie("127.0.0.1"),
        userAgent: UA,
        authHeader: "Bearer not-a-real-token",
      })
      expect(r.next).not.toHaveBeenCalled()
      expect(r.statusCode).toBe(403)
    })

    it("does not let a forged session cookie push a guest onto the full-access path", () => {
      const r = run("/api/projects", {
        ip: "127.0.0.1",
        host: "localhost",
        shareCookie: guestCookie("127.0.0.1"),
        sessionCookie: "forged",
        userAgent: UA,
      })
      expect(r.next).not.toHaveBeenCalled()
      expect(r.statusCode).toBe(403)
    })

    it("403s a guest laundering a request through the hub proxy prefix", () => {
      const r = run(`/hub/device-1/api/session-status/${SESSION_ID}`, {
        shareCookie: guestCookie(),
        userAgent: UA,
      })
      expect(r.next).not.toHaveBeenCalled()
      expect(r.statusCode).toBe(403)
    })

    it("403s a guest reaching for the PTY over HTTP", () => {
      const r = run("/__pty", { shareCookie: guestCookie(), userAgent: UA })
      expect(r.next).not.toHaveBeenCalled()
      expect(r.statusCode).toBe(403)
    })

    it("refuses a PTY WebSocket upgrade carrying only a share cookie", () => {
      const req = mockReq("/__pty", { shareCookie: guestCookie(), userAgent: UA })
      const status = websocketUpgradeRejection(req, new URL(`http://${HOST}/__pty`))
      expect(status).toBe(401)
    })

    it("keeps /api/share/verify public so an expired guest can log back in", () => {
      const r = run("/api/share/verify", {
        method: "POST",
        shareCookie: "expired-token",
        userAgent: UA,
        origin: `http://${HOST}`,
      })
      expect(r.next).toHaveBeenCalledOnce()
    })

    it("keeps /api/share/verify reachable with no cookie at all", () => {
      const r = run("/api/share/verify", { method: "POST" })
      expect(r.next).toHaveBeenCalledOnce()
    })

    it("lets a valid full session win over a share cookie", () => {
      const sessionToken = createSessionToken(
        GUEST_IP,
        UA,
        signIn === "account" ? ADMIN : undefined,
      )
      const r = run("/api/projects", {
        sessionCookie: sessionToken,
        shareCookie: guestCookie(),
        userAgent: UA,
      })
      expect(r.next).toHaveBeenCalledOnce()
      expect(r.statusCode).toBe(200)
    })
  })
}

