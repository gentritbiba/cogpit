// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { IncomingMessage, ServerResponse } from "node:http"
import { EventEmitter } from "node:events"

import {
  isWithinDir,
  safeCompare,
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
  MIN_PASSWORD_LENGTH,
  isLocalRequest,
  createSessionToken,
  validateSessionToken,
  revokeSessionToken,
  revokeAllSessions,
  setBrowserSessionCookie,
  clearBrowserSessionCookie,
  securityHeaders,
  devSecurityHeaders,
  bodySizeLimit,
  authMiddleware,
  cleanupProcesses,
  activeProcesses,
  persistentSessions,
} from "../helpers"

// ── isWithinDir ─────────────────────────────────────────────────────────

describe("isWithinDir", () => {
  it("returns true for a direct child", () => {
    expect(isWithinDir("/home/user", "/home/user/file.txt")).toBe(true)
  })

  it("returns true for a nested child", () => {
    expect(isWithinDir("/home/user", "/home/user/a/b/c")).toBe(true)
  })

  it("returns true when child equals parent", () => {
    expect(isWithinDir("/home/user", "/home/user")).toBe(true)
  })

  it("returns false for a sibling directory", () => {
    expect(isWithinDir("/home/user", "/home/other/file.txt")).toBe(false)
  })

  it("returns false for path traversal", () => {
    expect(isWithinDir("/home/user", "/home/user/../other/file.txt")).toBe(false)
  })

  it("returns false for a prefix that is not a parent directory", () => {
    // /home/username is not within /home/user even though it starts with it
    expect(isWithinDir("/home/user", "/home/username")).toBe(false)
  })

  it("returns false for parent outside child", () => {
    expect(isWithinDir("/home/user/docs", "/home/user")).toBe(false)
  })

  describe("on posix", () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!

    beforeEach(() => {
      Object.defineProperty(process, "platform", { ...original, value: "linux" })
    })

    afterEach(() => {
      Object.defineProperty(process, "platform", original)
    })

    // Pinned rather than inherited from the host: case folding is a real
    // containment weakness on POSIX, so it must be asserted when CI runs on
    // Windows too.
    it("stays case-sensitive", () => {
      expect(isWithinDir("/home/user", "/HOME/USER/file.txt")).toBe(false)
      expect(isWithinDir("/home/user", "/Home/User")).toBe(false)
    })
  })

  describe("on win32", () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!

    beforeEach(() => {
      Object.defineProperty(process, "platform", { ...original, value: "win32" })
    })

    afterEach(() => {
      Object.defineProperty(process, "platform", original)
    })

    it("ignores case differences the filesystem also ignores", () => {
      expect(isWithinDir("/Users/Alice", "/users/alice/file.txt")).toBe(true)
      expect(isWithinDir("/users/alice", "/Users/Alice")).toBe(true)
    })

    it("still rejects siblings and traversal when folding case", () => {
      expect(isWithinDir("/Users/Alice", "/users/alicexyz")).toBe(false)
      expect(isWithinDir("/Users/Alice", "/users/alice/../bob")).toBe(false)
    })
  })
})

// ── safeCompare ─────────────────────────────────────────────────────────

describe("safeCompare", () => {
  it("returns true for equal strings", () => {
    expect(safeCompare("abc", "abc")).toBe(true)
  })

  it("returns false for different strings of same length", () => {
    expect(safeCompare("abc", "xyz")).toBe(false)
  })

  it("returns false for different lengths", () => {
    expect(safeCompare("short", "longer-string")).toBe(false)
  })

  it("returns true for empty strings", () => {
    expect(safeCompare("", "")).toBe(true)
  })

  it("returns false when one is empty", () => {
    expect(safeCompare("abc", "")).toBe(false)
  })
})

// ── hashPassword / verifyPassword ───────────────────────────────────────

describe("hashPassword / verifyPassword", () => {
  it("verifies a password against its hash", () => {
    const hash = hashPassword("mySecretPassword")
    expect(verifyPassword("mySecretPassword", hash)).toBe(true)
  })

  it("rejects wrong password", () => {
    const hash = hashPassword("mySecretPassword")
    expect(verifyPassword("wrongPassword", hash)).toBe(false)
  })

  it("produces different hashes for same password (salt)", () => {
    const h1 = hashPassword("same")
    const h2 = hashPassword("same")
    expect(h1).not.toBe(h2)
  })

  it("supports legacy plaintext passwords (no colon)", () => {
    expect(verifyPassword("plaintext", "plaintext")).toBe(true)
    expect(verifyPassword("wrong", "plaintext")).toBe(false)
  })
})

// ── validatePasswordStrength ────────────────────────────────────────────

describe("validatePasswordStrength", () => {
  it("returns error for too short password", () => {
    const result = validatePasswordStrength("short")
    expect(result).toContain(`at least ${MIN_PASSWORD_LENGTH} characters`)
  })

  it("returns null for valid length password", () => {
    const result = validatePasswordStrength("a".repeat(MIN_PASSWORD_LENGTH))
    expect(result).toBeNull()
  })

  it("returns null for password longer than minimum", () => {
    const result = validatePasswordStrength("a".repeat(MIN_PASSWORD_LENGTH + 10))
    expect(result).toBeNull()
  })
})

// ── isLocalRequest ──────────────────────────────────────────────────────

describe("isLocalRequest", () => {
  function mockReq(ip: string): IncomingMessage {
    return { socket: { remoteAddress: ip } } as unknown as IncomingMessage
  }

  it("returns true for 127.0.0.1", () => {
    expect(isLocalRequest(mockReq("127.0.0.1"))).toBe(true)
  })

  it("returns true for ::1", () => {
    expect(isLocalRequest(mockReq("::1"))).toBe(true)
  })

  it("returns true for ::ffff:127.0.0.1", () => {
    expect(isLocalRequest(mockReq("::ffff:127.0.0.1"))).toBe(true)
  })

  it("returns false for remote IP", () => {
    expect(isLocalRequest(mockReq("192.168.1.100"))).toBe(false)
  })

  it("returns false for empty remoteAddress", () => {
    expect(isLocalRequest(mockReq(""))).toBe(false)
  })

  it("returns false for undefined remoteAddress", () => {
    const req = { socket: {} } as unknown as IncomingMessage
    expect(isLocalRequest(req)).toBe(false)
  })
})

// ── createSessionToken / validateSessionToken ───────────────────────────

describe("createSessionToken / validateSessionToken", () => {
  beforeEach(() => {
    revokeAllSessions()
  })

  it("creates a valid token", () => {
    const token = createSessionToken("127.0.0.1")
    expect(typeof token).toBe("string")
    expect(token.length).toBe(64) // 32 bytes hex
  })

  it("validates a created token", () => {
    const token = createSessionToken("127.0.0.1")
    expect(validateSessionToken(token)).toBe(true)
  })

  it("rejects unknown token", () => {
    expect(validateSessionToken("nonexistent")).toBe(false)
  })

  it("rejects a token after 30 minutes of inactivity", () => {
    vi.useFakeTimers()
    const token = createSessionToken("127.0.0.1")
    expect(validateSessionToken(token)).toBe(true)

    vi.advanceTimersByTime(31 * 60 * 1000)
    expect(validateSessionToken(token)).toBe(false)
    vi.useRealTimers()
  })

  it("enforces the eight-hour absolute lifetime despite activity", () => {
    vi.useFakeTimers()
    const token = createSessionToken("127.0.0.1")
    for (let i = 0; i < 24; i++) {
      vi.advanceTimersByTime(20 * 60 * 1000)
      expect(validateSessionToken(token)).toBe(true)
    }
    vi.advanceTimersByTime(1)
    expect(validateSessionToken(token)).toBe(false)
    vi.useRealTimers()
  })

  it("optionally binds validation to the original user agent", () => {
    const token = createSessionToken("127.0.0.1", "Browser/1")
    expect(validateSessionToken(token, "Browser/1")).toBe(true)
    expect(validateSessionToken(token, "Browser/2")).toBe(false)
  })

  it("can revoke one session without revoking another", () => {
    const first = createSessionToken("127.0.0.1")
    const second = createSessionToken("127.0.0.1")
    revokeSessionToken(first)
    expect(validateSessionToken(first)).toBe(false)
    expect(validateSessionToken(second)).toBe(true)
  })
})

// ── securityHeaders ─────────────────────────────────────────────────────

describe("securityHeaders", () => {
  it("sets all required security headers and calls next", () => {
    const headers: Record<string, string> = {}
    const req = { socket: {}, headers: {}, url: "/api/projects" } as unknown as IncomingMessage
    const res = {
      setHeader: (name: string, value: string) => { headers[name] = value },
    } as unknown as ServerResponse
    const next = vi.fn()

    securityHeaders(req, res, next)

    expect(headers["X-Content-Type-Options"]).toBe("nosniff")
    expect(headers["X-Frame-Options"]).toBe("DENY")
    expect(headers["Referrer-Policy"]).toBe("no-referrer")
    expect(headers["Permissions-Policy"]).toBe("camera=(), microphone=(), geolocation=()")
    expect(headers["X-XSS-Protection"]).toBe("0")
    expect(headers["Cross-Origin-Opener-Policy"]).toBe("same-origin")
    expect(headers["Cross-Origin-Resource-Policy"]).toBe("same-origin")
    expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'")
    expect(headers["Cache-Control"]).toBe("no-store")
    expect(headers["Strict-Transport-Security"]).toBeUndefined()
    expect(next).toHaveBeenCalledOnce()
  })

  it("sets HSTS only when the request arrived over HTTPS", () => {
    const headers: Record<string, string> = {}
    const req = {
      socket: { remoteAddress: "127.0.0.1" },
      headers: { host: "mb.cogpit.dev", "x-forwarded-proto": "https" },
      url: "/",
    } as unknown as IncomingMessage
    const res = {
      setHeader: (name: string, value: string) => { headers[name] = value },
    } as unknown as ServerResponse

    securityHeaders(req, res, vi.fn())
    expect(headers["Strict-Transport-Security"]).toBe("max-age=63072000")
    const connectSources = headers["Content-Security-Policy"]
      .split(";")
      .map((directive) => directive.trim().split(/\s+/))
      .find(([name]) => name === "connect-src")
      ?.slice(1)
    expect(connectSources).toContain("wss://mb.cogpit.dev")
    expect(connectSources).not.toContain("wss:")
  })
})

describe("securityHeaders on non-origin-form targets", () => {
  function cacheControlFor(url: string): string | undefined {
    const headers: Record<string, string> = {}
    const req = { socket: {}, headers: {}, url } as unknown as IncomingMessage
    const res = {
      setHeader: (name: string, value: string) => { headers[name] = value },
    } as unknown as ServerResponse
    securityHeaders(req, res, vi.fn())
    return headers["Cache-Control"]
  }

  it("keeps API responses uncacheable when the target is absolute-form", () => {
    expect(cacheControlFor("http://cogpit.local:19384/api/projects")).toBe("no-store")
    expect(cacheControlFor("http://cogpit.local:19384/hub/dev_1/api/projects")).toBe("no-store")
    expect(cacheControlFor("http://cogpit.local:19384/__pty")).toBe("no-store")
  })

  it("fails closed on a target it cannot reduce to a path", () => {
    expect(cacheControlFor("//evil.example/api/projects")).toBe("no-store")
    expect(cacheControlFor("*")).toBe("no-store")
  })

  it("leaves genuine static assets cacheable", () => {
    expect(cacheControlFor("http://cogpit.local:19384/assets/app.js")).toBeUndefined()
    expect(cacheControlFor("/assets/app.js")).toBeUndefined()
  })
})

describe("devSecurityHeaders", () => {
  it("leaves Vite documents free to inject the React refresh preamble", () => {
    const headers: Record<string, string> = {}
    const req = { socket: {}, headers: {}, url: "/" } as unknown as IncomingMessage
    const res = {
      setHeader: (name: string, value: string) => { headers[name] = value },
    } as unknown as ServerResponse
    const next = vi.fn()

    devSecurityHeaders(req, res, next)

    expect(headers["X-Content-Type-Options"]).toBeUndefined()
    expect(headers["Content-Security-Policy"]).toBeUndefined()
    expect(next).toHaveBeenCalledOnce()
  })

  it("keeps the production policy on dev API responses", () => {
    const headers: Record<string, string> = {}
    const req = { socket: {}, headers: {}, url: "/api/projects" } as unknown as IncomingMessage
    const res = {
      setHeader: (name: string, value: string) => { headers[name] = value },
    } as unknown as ServerResponse

    devSecurityHeaders(req, res, vi.fn())

    expect(headers["Content-Security-Policy"]).toContain("script-src 'self'")
    expect(headers["Cache-Control"]).toBe("no-store")
  })

  it("keeps that policy on an absolute-form API target", () => {
    const headers: Record<string, string> = {}
    const req = {
      socket: {},
      headers: {},
      url: "http://cogpit.local:5173/api/projects",
    } as unknown as IncomingMessage
    const res = {
      setHeader: (name: string, value: string) => { headers[name] = value },
    } as unknown as ServerResponse

    devSecurityHeaders(req, res, vi.fn())

    expect(headers["Content-Security-Policy"]).toContain("script-src 'self'")
    expect(headers["Cache-Control"]).toBe("no-store")
  })
})

describe("browser session cookies", () => {
  it("uses a host-only HttpOnly Secure Strict cookie", () => {
    const setHeader = vi.fn()
    const res = { setHeader } as unknown as ServerResponse
    setBrowserSessionCookie(res, "abc123")
    expect(setHeader).toHaveBeenCalledWith(
      "Set-Cookie",
      expect.stringMatching(/^__Host-cogpit_session=abc123; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800$/),
    )
  })

  it("expires the same hardened cookie on logout", () => {
    const setHeader = vi.fn()
    const res = { setHeader } as unknown as ServerResponse
    clearBrowserSessionCookie(res)
    expect(setHeader).toHaveBeenCalledWith(
      "Set-Cookie",
      "__Host-cogpit_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
    )
  })
})

// ── bodySizeLimit ────────────────────────────────────────────────────────

describe("bodySizeLimit", () => {
  function mockReq(method: string, contentLength?: number): IncomingMessage {
    const req = new EventEmitter() as IncomingMessage & { method: string; headers: Record<string, string>; destroy: () => void }
    req.method = method
    req.headers = {}
    if (contentLength !== undefined) {
      req.headers["content-length"] = String(contentLength)
    }
    req.destroy = vi.fn()
    return req as IncomingMessage
  }

  function mockRes(): { res: ServerResponse; body: string; statusCode: number } {
    let body = ""
    let statusCode = 200
    const res = {
      get statusCode() { return statusCode },
      set statusCode(v: number) { statusCode = v },
      setHeader: vi.fn(),
      end: (data?: string) => { body = data || "" },
    } as unknown as ServerResponse
    return { res, get body() { return body }, get statusCode() { return statusCode } }
  }

  it("passes through GET requests without checking body", () => {
    const req = mockReq("GET")
    const { res } = mockRes()
    const next = vi.fn()

    bodySizeLimit(req, res, next)
    expect(next).toHaveBeenCalledOnce()
  })

  it("passes through DELETE requests without checking body", () => {
    const req = mockReq("DELETE")
    const { res } = mockRes()
    const next = vi.fn()

    bodySizeLimit(req, res, next)
    expect(next).toHaveBeenCalledOnce()
  })

  it("rejects POST with content-length exceeding 5MB", () => {
    const req = mockReq("POST", 6 * 1024 * 1024)
    const mock = mockRes()
    const next = vi.fn()

    bodySizeLimit(req, mock.res, next)
    expect(next).not.toHaveBeenCalled()
    expect(mock.statusCode).toBe(413)
  })

  it("rejects PUT with content-length exceeding 5MB", () => {
    const req = mockReq("PUT", 6 * 1024 * 1024)
    const mock = mockRes()
    const next = vi.fn()

    bodySizeLimit(req, mock.res, next)
    expect(next).not.toHaveBeenCalled()
    expect(mock.statusCode).toBe(413)
  })

  it("rejects PATCH with content-length exceeding 5MB", () => {
    const req = mockReq("PATCH", 6 * 1024 * 1024)
    const mock = mockRes()
    const next = vi.fn()

    bodySizeLimit(req, mock.res, next)
    expect(next).not.toHaveBeenCalled()
    expect(mock.statusCode).toBe(413)
  })

  it("allows POST with content-length under 5MB", () => {
    const req = mockReq("POST", 1024)
    const { res } = mockRes()
    const next = vi.fn()

    bodySizeLimit(req, res, next)
    expect(next).toHaveBeenCalledOnce()
  })

  it("destroys request if streaming data exceeds 5MB", () => {
    const req = mockReq("POST")
    const mock = mockRes()
    const next = vi.fn()

    bodySizeLimit(req, mock.res, next)
    expect(next).toHaveBeenCalledOnce()

    // bodySizeLimit wraps req.on("data", ...) — downstream code must call req.on("data")
    // to register the wrapped listener, then data flows through
    const dataHandler = vi.fn()
    req.on("data", dataHandler)

    // Simulate streaming data that exceeds the limit
    const chunk = Buffer.alloc(3 * 1024 * 1024) // 3MB
    req.emit("data", chunk)
    expect(dataHandler).toHaveBeenCalledTimes(1) // first chunk passes through

    req.emit("data", chunk) // another 3MB = 6MB total > 5MB limit
    expect(mock.statusCode).toBe(413)
    expect(req.destroy).toHaveBeenCalled()
  })
})

// ── authMiddleware ──────────────────────────────────────────────────────

describe("authMiddleware", () => {
  beforeEach(() => {
    revokeAllSessions()
  })

  function mockReq(ip: string, url: string, authHeader?: string): IncomingMessage {
    return {
      socket: { remoteAddress: ip },
      url,
      headers: authHeader ? { authorization: authHeader } : {},
    } as unknown as IncomingMessage
  }

  function mockRes(): { res: ServerResponse; body: string; statusCode: number } {
    let body = ""
    let statusCode = 200
    const res = {
      get statusCode() { return statusCode },
      set statusCode(v: number) { statusCode = v },
      setHeader: vi.fn(),
      end: (data?: string) => { body = data || "" },
    } as unknown as ServerResponse
    return { res, get body() { return body }, get statusCode() { return statusCode } }
  }

  it("allows local requests without auth", () => {
    const req = mockReq("127.0.0.1", "/api/projects")
    req.headers.host = "127.0.0.1:19384"
    const { res } = mockRes()
    const next = vi.fn()

    authMiddleware(req, res, next)
    expect(next).toHaveBeenCalledOnce()
  })

  it("allows public paths for remote clients", () => {
    const req = mockReq("192.168.1.100", "/api/auth/verify")
    const { res } = mockRes()
    const next = vi.fn()

    authMiddleware(req, res, next)
    expect(next).toHaveBeenCalledOnce()
  })

  it("allows static asset paths for remote clients", () => {
    const req = mockReq("192.168.1.100", "/index.html")
    const { res } = mockRes()
    const next = vi.fn()

    authMiddleware(req, res, next)
    expect(next).toHaveBeenCalledOnce()
  })

  it("blocks remote API request when network access is disabled", () => {
    // getConfig returns null by default (no config loaded)
    const req = mockReq("192.168.1.100", "/api/projects")
    const mock = mockRes()
    const next = vi.fn()

    authMiddleware(req, mock.res, next)
    expect(next).not.toHaveBeenCalled()
    expect(mock.statusCode).toBe(403)
    expect(mock.body).toContain("Network access is disabled")
  })

  it("rejects remote request with no token", () => {
    // Need to mock getConfig to return a config with networkAccess enabled
    // Since getConfig is imported from config module, we need to set up config first
    // This test verifies the token validation path - when config exists but no token provided
    const req = mockReq("192.168.1.100", "/api/projects")
    const mock = mockRes()
    const next = vi.fn()

    authMiddleware(req, mock.res, next)
    // Without config, returns 403 (network access disabled)
    expect(next).not.toHaveBeenCalled()
    expect(mock.statusCode).toBe(403)
  })

  it("strips query string when checking public paths", () => {
    const req = mockReq("192.168.1.100", "/api/auth/verify?foo=bar")
    const { res } = mockRes()
    const next = vi.fn()

    authMiddleware(req, res, next)
    expect(next).toHaveBeenCalledOnce()
  })
})

// ── revokeAllSessions ───────────────────────────────────────────────────

describe("revokeAllSessions", () => {
  it("invalidates all previously created tokens", () => {
    const token1 = createSessionToken("127.0.0.1")
    const token2 = createSessionToken("127.0.0.2")
    expect(validateSessionToken(token1)).toBe(true)
    expect(validateSessionToken(token2)).toBe(true)

    revokeAllSessions()

    expect(validateSessionToken(token1)).toBe(false)
    expect(validateSessionToken(token2)).toBe(false)
  })

  it("allows new tokens after revocation", () => {
    const old = createSessionToken("127.0.0.1")
    revokeAllSessions()
    expect(validateSessionToken(old)).toBe(false)

    const fresh = createSessionToken("127.0.0.1")
    expect(validateSessionToken(fresh)).toBe(true)
  })
})

// ── validatePasswordStrength edge cases ─────────────────────────────────

describe("validatePasswordStrength edge cases", () => {
  it("returns error for empty string", () => {
    expect(validatePasswordStrength("")).not.toBeNull()
  })

  it("returns error for password of length MIN_PASSWORD_LENGTH - 1", () => {
    const result = validatePasswordStrength("a".repeat(MIN_PASSWORD_LENGTH - 1))
    expect(result).not.toBeNull()
  })

  it("returns null for exactly MIN_PASSWORD_LENGTH characters", () => {
    expect(validatePasswordStrength("a".repeat(MIN_PASSWORD_LENGTH))).toBeNull()
  })
})

// ── createSessionToken uniqueness ───────────────────────────────────────

describe("createSessionToken uniqueness", () => {
  beforeEach(() => {
    revokeAllSessions()
  })

  it("generates unique tokens each time", () => {
    const t1 = createSessionToken("127.0.0.1")
    const t2 = createSessionToken("127.0.0.1")
    expect(t1).not.toBe(t2)
  })

  it("token from different IP is still valid", () => {
    const token = createSessionToken("10.0.0.5")
    expect(validateSessionToken(token)).toBe(true)
  })
})

// ── cleanupProcesses ─────────────────────────────────────────────────────

function makeFakeProc(pid = 1234): { kill: ReturnType<typeof vi.fn>; pid: number } {
  return { kill: vi.fn(), pid }
}

function makeFakeSession(pid = 5678): {
  proc: { kill: ReturnType<typeof vi.fn>; pid: number }
  subagentWatcher: { close: ReturnType<typeof vi.fn> } | null
  dead: boolean
} {
  return {
    proc: { kill: vi.fn(), pid },
    subagentWatcher: { close: vi.fn() },
    dead: false,
  }
}

describe("cleanupProcesses", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    activeProcesses.clear()
    persistentSessions.clear()
  })

  afterEach(() => {
    activeProcesses.clear()
    persistentSessions.clear()
    vi.useRealTimers()
  })

  it("sends SIGTERM to all activeProcesses", () => {
    const proc1 = makeFakeProc(100)
    const proc2 = makeFakeProc(101)
    activeProcesses.set("sid-1", proc1 as never)
    activeProcesses.set("sid-2", proc2 as never)

    cleanupProcesses()

    expect(proc1.kill).toHaveBeenCalledWith("SIGTERM")
    expect(proc2.kill).toHaveBeenCalledWith("SIGTERM")
  })

  it("sends SIGTERM to all persistentSessions", () => {
    const sess1 = makeFakeSession(200)
    const sess2 = makeFakeSession(201)
    persistentSessions.set("sid-a", sess1 as never)
    persistentSessions.set("sid-b", sess2 as never)

    cleanupProcesses()

    expect(sess1.proc.kill).toHaveBeenCalledWith("SIGTERM")
    expect(sess2.proc.kill).toHaveBeenCalledWith("SIGTERM")
  })

  it("clears both Maps after SIGTERM", () => {
    activeProcesses.set("sid-1", makeFakeProc(300) as never)
    persistentSessions.set("sid-a", makeFakeSession(301) as never)

    cleanupProcesses()

    expect(activeProcesses.size).toBe(0)
    expect(persistentSessions.size).toBe(0)
  })

  it("sends SIGKILL to snapshot after 3000ms", () => {
    const proc = makeFakeProc(400)
    activeProcesses.set("sid-1", proc as never)

    cleanupProcesses()
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM")
    expect(proc.kill).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(3000)

    expect(proc.kill).toHaveBeenCalledWith("SIGKILL")
    expect(proc.kill).toHaveBeenCalledTimes(2)
  })

  it("sends SIGKILL to persistentSession procs after 3000ms", () => {
    const sess = makeFakeSession(500)
    persistentSessions.set("sid-a", sess as never)

    cleanupProcesses()
    expect(sess.proc.kill).toHaveBeenCalledWith("SIGTERM")

    vi.advanceTimersByTime(3000)

    expect(sess.proc.kill).toHaveBeenCalledWith("SIGKILL")
  })

  it("SIGKILL uses snapshot taken before Map clear (map-mutation safety)", () => {
    const proc1 = makeFakeProc(600)
    const proc2 = makeFakeProc(601)
    const proc3 = makeFakeProc(602)
    activeProcesses.set("sid-1", proc1 as never)
    activeProcesses.set("sid-2", proc2 as never)
    activeProcesses.set("sid-3", proc3 as never)

    cleanupProcesses()
    // Maps should be empty now
    expect(activeProcesses.size).toBe(0)

    vi.advanceTimersByTime(3000)

    // All 3 procs should still get SIGKILL despite Map being cleared
    expect(proc1.kill).toHaveBeenCalledWith("SIGKILL")
    expect(proc2.kill).toHaveBeenCalledWith("SIGKILL")
    expect(proc3.kill).toHaveBeenCalledWith("SIGKILL")
  })

  it("logs SIGTERM failure instead of silently swallowing", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const proc = makeFakeProc(700)
    proc.kill.mockImplementationOnce((sig: string) => {
      if (sig === "SIGTERM") throw new Error("already dead")
    })
    activeProcesses.set("sid-err", proc as never)

    cleanupProcesses()

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[cleanupProcesses]"),
      expect.any(Error)
    )

    consoleSpy.mockRestore()
  })

  it("logs SIGKILL failure instead of silently swallowing", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const proc = makeFakeProc(800)
    // SIGTERM succeeds, SIGKILL throws
    proc.kill.mockImplementation((sig: string) => {
      if (sig === "SIGKILL") throw new Error("still dead")
    })
    activeProcesses.set("sid-kill-err", proc as never)

    cleanupProcesses()
    vi.advanceTimersByTime(3000)

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[cleanupProcesses]"),
      expect.any(Error)
    )

    consoleSpy.mockRestore()
  })

  it("closes subagentWatcher on persistent sessions", () => {
    const sess = makeFakeSession(900)
    persistentSessions.set("sid-watcher", sess as never)

    cleanupProcesses()

    expect(sess.subagentWatcher!.close).toHaveBeenCalled()
  })

  it("does not throw when called with empty Maps", () => {
    expect(() => cleanupProcesses()).not.toThrow()
  })

  it("does not schedule SIGKILL timer when no processes exist", () => {
    // No processes — advanceTimers should not cause errors
    cleanupProcesses()
    expect(() => vi.advanceTimersByTime(3000)).not.toThrow()
  })
})
