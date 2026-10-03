// @vitest-environment node
import { describe, it, expect, vi } from "vitest"

import {
  createSessionToken,
  handleShareRequest,
  websocketUpgradeRejection,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
} from "../../security"
import { useAccountSignIn } from "../edition/fakeEdition"
import { createMiddlewareRes } from "../http-fixtures"
import {
  DIR_NAME,
  FILE_NAME,
  GUEST_IP,
  HOST,
  SESSION_ID,
  UA,
  describeSharedBranch,
  guestCookie,
  mockReq,
  mockedGetConfig,
  run,
  useShareAuthFixture,
} from "./authBranchSuite"

vi.mock("../../config", () => ({ getConfig: vi.fn() }))

useShareAuthFixture()

describeSharedBranch("password")

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

  it("ignores the switch where the edition signs accounts in, whose credentials replace it", () => {
    useAccountSignIn()
    mockedGetConfig.mockReturnValue(null as never)
    const req = mockReq(`/api/session-status/${SESSION_ID}`, { userAgent: UA })
    const next = vi.fn()
    handleShareRequest(req, createMiddlewareRes().res, next, guestCookie())
    expect(next).toHaveBeenCalledOnce()
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
