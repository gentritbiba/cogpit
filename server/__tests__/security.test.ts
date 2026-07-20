// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"
import type { IncomingMessage, ServerResponse } from "node:http"
import { randomBytes, createHash } from "node:crypto"
import {
  hashPassword,
  verifyPassword,
  isPasswordHashed,
  authMiddleware,
  createSessionToken,
  revokeAllSessions,
} from "../security"
import { getConfig } from "../config"

vi.mock("../config", () => ({ getConfig: vi.fn() }))

const mockedGetConfig = vi.mocked(getConfig)

describe("hashPassword", () => {
  it("produces a string starting with the $sha256$ prefix", () => {
    const hash = hashPassword("somepassword123")
    expect(hash.startsWith("$sha256$")).toBe(true)
  })

  it("produces a string with a colon-separated salt and hash after the prefix", () => {
    const hash = hashPassword("somepassword123")
    const inner = hash.slice("$sha256$".length)
    const parts = inner.split(":")
    expect(parts).toHaveLength(2)
    // salt: 32 hex chars, hash: 64 hex chars
    expect(parts[0]).toMatch(/^[0-9a-f]{32}$/)
    expect(parts[1]).toMatch(/^[0-9a-f]{64}$/)
  })

  it("produces a different hash each call (salt randomness)", () => {
    const h1 = hashPassword("samepassword123")
    const h2 = hashPassword("samepassword123")
    expect(h1).not.toBe(h2)
  })
})

describe("verifyPassword", () => {
  it("returns true for a matching plaintext + hash pair", () => {
    const hash = hashPassword("correcthorsebattery")
    expect(verifyPassword("correcthorsebattery", hash)).toBe(true)
  })

  it("returns false for a wrong password against a hash", () => {
    const hash = hashPassword("correcthorsebattery")
    expect(verifyPassword("wrongpassword", hash)).toBe(false)
  })

  it("re-hashing the same password produces a different hash that still verifies", () => {
    const h1 = hashPassword("mysecretword1234")
    const h2 = hashPassword("mysecretword1234")
    expect(h1).not.toBe(h2)
    expect(verifyPassword("mysecretword1234", h1)).toBe(true)
    expect(verifyPassword("mysecretword1234", h2)).toBe(true)
  })

  it("handles legacy format (no prefix, salt:hash) for backward compat", () => {
    // Simulate a hash produced by the old hashPassword that lacked the $sha256$ prefix.
    // Old format: <32-hex-salt>:<64-hex-sha256>
    const salt = randomBytes(16).toString("hex") // 32 hex chars
    const password = "legacypassword123"
    const hash = createHash("sha256").update(salt + password).digest("hex")
    const legacyStored = `${salt}:${hash}`

    expect(verifyPassword(password, legacyStored)).toBe(true)
    expect(verifyPassword("wrongpassword", legacyStored)).toBe(false)
  })

  it("returns true for plaintext fallback (stored value has no colon)", () => {
    // Very old plaintext passwords stored before any hashing
    expect(verifyPassword("plaintextpass", "plaintextpass")).toBe(true)
    expect(verifyPassword("wrongpass", "plaintextpass")).toBe(false)
  })
})

describe("isPasswordHashed", () => {
  it("returns true for a freshly hashed password", () => {
    const hash = hashPassword("mypassword12345")
    expect(isPasswordHashed(hash)).toBe(true)
  })

  it("returns false for a plaintext password", () => {
    expect(isPasswordHashed("plaintextpassword")).toBe(false)
    expect(isPasswordHashed("mypassword12345")).toBe(false)
  })

  it("returns false for a short string that cannot be a hash", () => {
    expect(isPasswordHashed("short")).toBe(false)
    expect(isPasswordHashed("")).toBe(false)
  })

  it("returns true for legacy hashed format (salt:hash, no prefix)", () => {
    const salt = randomBytes(16).toString("hex")
    const hash = createHash("sha256").update(salt + "pw").digest("hex")
    expect(isPasswordHashed(`${salt}:${hash}`)).toBe(true)
  })

  it("returns false for a plaintext password that contains a colon but is not a hash", () => {
    // e.g. "pass:word" — colon not at position 32, so not confused with legacy hash
    expect(isPasswordHashed("pass:word")).toBe(false)
    expect(isPasswordHashed("user:pass")).toBe(false)
  })
})

// ── authMiddleware path protection ──────────────────────────────────────
//
// Pins which URL prefixes require auth for remote clients. /hub/* is the
// multi-device reverse proxy: if it ever falls through as "public", every
// registered device becomes reachable without a token, and the SPA fallback
// hides the mistake by answering 200 HTML instead of 401.

describe("authMiddleware path protection", () => {
  const REMOTE_IP = "192.168.1.100"

  beforeEach(() => {
    revokeAllSessions()
    // Network access must be enabled, otherwise the middleware short-circuits
    // to 403 ("Network access is disabled") before reaching the token check.
    mockedGetConfig.mockReturnValue({
      claudeDir: "/tmp/claude",
      networkAccess: true,
      networkPassword: hashPassword("networkpassword123"),
    })
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

  function run(url: string, opts: { ip?: string; authHeader?: string } = {}) {
    const req = mockReq(opts.ip ?? REMOTE_IP, url, opts.authHeader)
    const mock = mockRes()
    const next = vi.fn()
    authMiddleware(req, mock.res, next)
    return { next, get statusCode() { return mock.statusCode }, get body() { return mock.body } }
  }

  // ── /hub/* is protected (new) ──

  it("rejects a remote /hub/*/api/* request with no token", () => {
    const r = run("/hub/dev_abc123/api/projects")
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(401)
    expect(r.body).toContain("Authentication required")
  })

  it("rejects a remote /hub/*/__pty request with no token", () => {
    const r = run("/hub/dev_abc123/__pty")
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(401)
  })

  it("does not let the /hub/ prefix smuggle a public path past auth", () => {
    // PUBLIC_PATHS is matched on the whole path, so a proxied /api/hello
    // still requires a hub token — the exemption is local-only.
    const r = run("/hub/dev_abc123/api/hello")
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(401)
  })

  // ── case-variant prefixes must not bypass auth (Express routes case-insensitively) ──

  it("rejects a remote /HUB/*/api/* request with no token (case-variant bypass)", () => {
    const r = run("/HUB/dev_abc123/api/projects")
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(401)
  })

  it("rejects a remote /API/* request with no token (case-variant bypass)", () => {
    const r = run("/API/config")
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(401)
  })

  it("rejects a remote /__PTY request with no token (case-variant bypass)", () => {
    const r = run("/__PTY")
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(401)
  })

  it("allows a remote /hub/* request carrying a valid token", () => {
    const token = createSessionToken(REMOTE_IP)
    const r = run("/hub/dev_abc123/api/projects", { authHeader: `Bearer ${token}` })
    expect(r.next).toHaveBeenCalledOnce()
  })

  it("blocks a remote /hub/* request when network access is disabled", () => {
    mockedGetConfig.mockReturnValue(null)
    const r = run("/hub/dev_abc123/api/projects")
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(403)
    expect(r.body).toContain("Network access is disabled")
  })

  // ── /api/hello is public (new) ──

  it("allows a remote /api/hello request with no token", () => {
    const r = run("/api/hello")
    expect(r.next).toHaveBeenCalledOnce()
  })

  it("allows a remote /api/hello request with a query string", () => {
    const r = run("/api/hello?probe=1")
    expect(r.next).toHaveBeenCalledOnce()
  })

  // ── existing behaviour, unchanged ──

  it("allows local requests without auth", () => {
    const r = run("/api/projects", { ip: "127.0.0.1" })
    expect(r.next).toHaveBeenCalledOnce()
  })

  it("allows local /hub/* requests without auth", () => {
    const r = run("/hub/dev_abc123/api/projects", { ip: "127.0.0.1" })
    expect(r.next).toHaveBeenCalledOnce()
  })

  it("rejects a remote /api/* request with no token", () => {
    const r = run("/api/projects")
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(401)
  })

  it("rejects a remote /__pty request with no token", () => {
    const r = run("/__pty")
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(401)
  })

  it("allows a remote /api/* request carrying a valid token", () => {
    const token = createSessionToken(REMOTE_IP)
    const r = run("/api/projects", { authHeader: `Bearer ${token}` })
    expect(r.next).toHaveBeenCalledOnce()
  })

  it("allows /api/auth/verify for remote clients", () => {
    const r = run("/api/auth/verify")
    expect(r.next).toHaveBeenCalledOnce()
  })

  it("allows non-API paths for remote clients", () => {
    expect(run("/index.html").next).toHaveBeenCalledOnce()
    expect(run("/assets/app.js").next).toHaveBeenCalledOnce()
    expect(run("/d/dev_abc123/some-session").next).toHaveBeenCalledOnce()
  })
})
