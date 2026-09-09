// @vitest-environment node
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest"
import type { IncomingMessage } from "node:http"
import { createMiddlewareRes } from "../http-fixtures"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  authMiddleware,
  websocketUpgradeRejection,
  countShareGuests,
  createShareToken,
  createSessionToken,
  __resetShareTokensForTest,
  __resetSessionsForTest,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
  type SessionPrincipal,
} from "../../security"
import { getConfig } from "../../config"
import { initShareRegistry, createShare, removeShare } from "../../share/registry"
import { initEdition, __resetEditionForTest } from "../../team/edition"
import { getRequestPrincipal } from "../../team/requestPrincipal"
import { isShareGuestRequest } from "../../share/requestGuest"
import { __resetForTest as __resetSessionPersistenceForTest } from "../../team/sessionPersistence"

vi.mock("../../config", () => ({ getConfig: vi.fn() }))

const mockedGetConfig = vi.mocked(getConfig)

const SESSION_ID = "sess-1"
const DIR_NAME = "-Users-me-proj"
const FILE_NAME = "sess-1.jsonl"
const UA = "Guest/1"
const GUEST_IP = "203.0.113.5"
const HOST = "cogpit.example"

const ADMIN: SessionPrincipal = { userId: "u1", username: "admin", role: "admin" }

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

function mockReq(url: string, opts: RequestOptions = {}): IncomingMessage {
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

function run(url: string, opts: RequestOptions = {}) {
  const req = mockReq(url, opts)
  const mock = createMiddlewareRes()
  const next = vi.fn()
  authMiddleware(req, mock.res, next)
  return { req, next, get statusCode() { return mock.statusCode }, get body() { return mock.body } }
}

/** A guest cookie for the shared session, pinned to the default UA. */
function guestCookie(ip = GUEST_IP): string {
  return createShareToken(SESSION_ID, ip, UA)
}

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
  __resetSessionPersistenceForTest()
  if (originalEditionEnv === undefined) delete process.env.COGPIT_EDITION
  else process.env.COGPIT_EDITION = originalEditionEnv
})

/**
 * Every case that must hold identically in both editions. Team edition trusts
 * nothing — loopback included — so a divergence here means one edition grew a
 * guest-reachable path the other does not have.
 */
function describeSharedBranch(edition: "personal" | "team"): void {
  describe(`share branch in ${edition} edition`, () => {
    beforeEach(() => {
      if (edition === "team") initEdition({ shell: "standalone", configEdition: "team" })
      if (edition === "team") mockedGetConfig.mockReturnValue(null)
    })

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
      // Team edition's authz middleware runs next and refuses anything it
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
        edition === "team" ? ADMIN : undefined,
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

describeSharedBranch("personal")
describeSharedBranch("team")

/**
 * A share is remote access, so it lives behind the same switch every other
 * remote request does. Without this the guest branch — which sits above the
 * gate — would admit a guest on a request an ordinary remote user gets 403 on.
 */
describe("share branch network access gate", () => {
  it("403s a guest when network access is turned off", () => {
    mockedGetConfig.mockReturnValue({ networkAccess: false, networkPassword: "hashed" } as never)
    const r = run(`/api/session-status/${SESSION_ID}`, {
      shareCookie: guestCookie(),
      userAgent: UA,
    })
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(403)
    expect(r.body).toContain("Network access is disabled")
  })

  it("403s a guest when no network password is set", () => {
    mockedGetConfig.mockReturnValue({ networkAccess: true, networkPassword: "" } as never)
    const r = run(`/api/session-status/${SESSION_ID}`, {
      shareCookie: guestCookie(),
      userAgent: UA,
    })
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(403)
  })

  it("403s a guest when there is no config at all", () => {
    mockedGetConfig.mockReturnValue(null as never)
    const r = run(`/api/session-status/${SESSION_ID}`, {
      shareCookie: guestCookie(),
      userAgent: UA,
    })
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(403)
  })

  it("gates before the token, so a revoked guest cannot tell shares apart", () => {
    // The gate must sit above token validation: a 401 here would say "network
    // is on, your token is stale" to someone the switch already locked out.
    mockedGetConfig.mockReturnValue({ networkAccess: false, networkPassword: "hashed" } as never)
    const r = run(`/api/session-status/${SESSION_ID}`, {
      shareCookie: "deadbeef",
      userAgent: UA,
    })
    expect(r.statusCode).toBe(403)
    expect(r.body).toContain("Network access is disabled")
  })

  it("still admits the host's own loopback browser with network access off", () => {
    mockedGetConfig.mockReturnValue({ networkAccess: false, networkPassword: "" } as never)
    const r = run(`/api/session-status/${SESSION_ID}`, {
      ip: "127.0.0.1",
      host: "localhost",
      shareCookie: guestCookie("127.0.0.1"),
      userAgent: UA,
    })
    expect(r.next).toHaveBeenCalledOnce()
  })

  it("still 403s a non-allowlisted route for that loopback guest", () => {
    mockedGetConfig.mockReturnValue({ networkAccess: false, networkPassword: "" } as never)
    const r = run("/api/projects", {
      ip: "127.0.0.1",
      host: "localhost",
      shareCookie: guestCookie("127.0.0.1"),
      userAgent: UA,
    })
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(403)
    expect(r.body).toContain("Not available on a shared session")
  })

  it("ignores the switch in team edition, where user credentials replace it", () => {
    initEdition({ shell: "standalone", configEdition: "team" })
    mockedGetConfig.mockReturnValue(null as never)
    const r = run(`/api/session-status/${SESSION_ID}`, {
      shareCookie: guestCookie(),
      userAgent: UA,
    })
    expect(r.next).toHaveBeenCalledOnce()
  })
})

describe("share branch preconditions", () => {
  it("hands the host the loopback shortcut when no share cookie is present", () => {
    // The control for THE escalation test: without this passing, the loopback
    // case above could be green for the wrong reason.
    const r = run("/api/projects", { ip: "127.0.0.1", host: "localhost", userAgent: UA })
    expect(r.next).toHaveBeenCalledOnce()
  })

  it("403s a share cookie arriving on an untrusted loopback host", () => {
    const r = run(`/api/session-status/${SESSION_ID}`, {
      ip: "127.0.0.1",
      host: "attacker.example",
      shareCookie: guestCookie("127.0.0.1"),
      userAgent: UA,
    })
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(403)
    expect(r.body).toContain("Untrusted local host")
  })

  it("keeps static asset paths reachable for a guest so the app can load", () => {
    const r = run("/assets/index.js", { shareCookie: guestCookie(), userAgent: UA })
    expect(r.next).toHaveBeenCalledOnce()
  })
})

describe("share branch attack surface", () => {
  it("rejects traversal and encoded separators in the shared stream path", () => {
    for (const url of [
      `/api/watch/${DIR_NAME}/..%2f..%2fetc%2fpasswd`,
      `/api/watch/${DIR_NAME}/../../../api/projects`,
      `/api/sessions/${DIR_NAME}%2f..%2f${DIR_NAME}/${FILE_NAME}`,
      `/api/session-status/${SESSION_ID}/../../projects`,
    ]) {
      const r = run(url, { shareCookie: guestCookie(), userAgent: UA })
      expect(r.next, url).not.toHaveBeenCalled()
      expect(r.statusCode, url).toBe(403)
    }
  })

  it("does not let a query string smuggle an allowed path onto a denied route", () => {
    const r = run(`/api/projects?path=/api/session-status/${SESSION_ID}`, {
      shareCookie: guestCookie(),
      userAgent: UA,
    })
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(403)
  })

  it("does not let a case-variant route name launder past the allowlist", () => {
    // Express routes case-insensitively, so /API/... would still reach the
    // handler; the allowlist matches route names raw and denies it.
    const r = run(`/API/session-status/${SESSION_ID}`, {
      shareCookie: guestCookie(),
      userAgent: UA,
    })
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(403)
  })

  it("does not let the hub proxy prefix launder a share-namespace mutation", () => {
    const r = run("/hub/device-1/api/share/send-message", {
      method: "POST",
      shareCookie: guestCookie(),
      userAgent: UA,
      origin: `http://${HOST}`,
    })
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(403)
  })

  it("rejects a mutation from a sibling site that passes the Origin check", () => {
    const r = run("/api/share/send-message", {
      method: "POST",
      shareCookie: guestCookie(),
      userAgent: UA,
      origin: `http://${HOST}`,
      fetchSite: "same-site",
    })
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(403)
  })

  it("refuses a PTY upgrade that presents a share token as a query token", () => {
    const token = guestCookie()
    const req = mockReq("/__pty", { shareCookie: token, userAgent: UA })
    const url = new URL(`http://${HOST}/__pty?token=${token}`)
    expect(websocketUpgradeRejection(req, url)).toBe(401)
  })

  it("401s a share token past its idle window", () => {
    vi.useFakeTimers()
    try {
      const token = guestCookie()
      vi.advanceTimersByTime(SESSION_IDLE_TTL_MS + 1)
      const r = run(`/api/session-status/${SESSION_ID}`, { shareCookie: token, userAgent: UA })
      expect(r.next).not.toHaveBeenCalled()
      expect(r.statusCode).toBe(401)
    } finally {
      vi.useRealTimers()
    }
  })

  it("401s a share token past its absolute lifetime even while it stays busy", () => {
    vi.useFakeTimers()
    try {
      const token = guestCookie()
      const url = `/api/session-status/${SESSION_ID}`
      // Kept warm well inside the idle window the whole time.
      for (let elapsed = 0; elapsed < SESSION_ABSOLUTE_TTL_MS; elapsed += SESSION_IDLE_TTL_MS / 2) {
        expect(run(url, { shareCookie: token, userAgent: UA }).next).toHaveBeenCalledOnce()
        vi.advanceTimersByTime(SESSION_IDLE_TTL_MS / 2)
      }
      vi.advanceTimersByTime(1)
      const r = run(url, { shareCookie: token, userAgent: UA })
      expect(r.next).not.toHaveBeenCalled()
      expect(r.statusCode).toBe(401)
    } finally {
      vi.useRealTimers()
    }
  })

  it("lets a valid bearer token win over a share cookie", () => {
    const bearer = createSessionToken(GUEST_IP, UA)
    const r = run("/api/projects", {
      authHeader: `Bearer ${bearer}`,
      shareCookie: guestCookie(),
      userAgent: UA,
    })
    expect(r.next).toHaveBeenCalledOnce()
  })
})
