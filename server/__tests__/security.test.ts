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
  websocketUpgradeRejection,
  isTrustedDirectLocalRequest,
  isMalformedPasswordHash,
  needsPasswordRehash,
  verifyPasswordAsync,
} from "../security"
import { getConfig } from "../config"

vi.mock("../config", () => ({ getConfig: vi.fn() }))

const mockedGetConfig = vi.mocked(getConfig)

describe("hashPassword", () => {
  it("produces a versioned scrypt hash", () => {
    const hash = hashPassword("somepassword123")
    expect(hash).toMatch(/^\$scrypt\$16384\$8\$5\$[0-9a-f]{32}\$[0-9a-f]{128}$/)
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

  it("handles the previous prefixed SHA-256 format for backward compat", () => {
    const salt = randomBytes(16).toString("hex")
    const password = "legacypassword123"
    const hash = createHash("sha256").update(salt + password).digest("hex")

    expect(verifyPassword(password, `$sha256$${salt}:${hash}`)).toBe(true)
    expect(verifyPassword("wrongpassword", `$sha256$${salt}:${hash}`)).toBe(false)
  })

  it("returns true for plaintext fallback (stored value has no colon)", () => {
    // Very old plaintext passwords stored before any hashing
    expect(verifyPassword("plaintextpass", "plaintextpass")).toBe(true)
    expect(verifyPassword("wrongpass", "plaintextpass")).toBe(false)
  })

  it("keeps very old plaintext passwords containing a colon compatible", () => {
    expect(verifyPassword("pass:word", "pass:word")).toBe(true)
    expect(verifyPassword("wrong:word", "pass:word")).toBe(false)
  })

  it("rejects malformed versioned hashes instead of treating them as plaintext", async () => {
    const malformed = "$scrypt$future-format"
    expect(isMalformedPasswordHash(malformed)).toBe(true)
    expect(verifyPassword(malformed, malformed)).toBe(false)
    await expect(verifyPasswordAsync(malformed, malformed)).resolves.toBe(false)
  })

  it("verifies current hashes asynchronously and identifies legacy upgrades", async () => {
    const current = hashPassword("correcthorsebattery")
    expect(needsPasswordRehash(current)).toBe(false)
    await expect(verifyPasswordAsync("correcthorsebattery", current)).resolves.toBe(true)
    await expect(verifyPasswordAsync("wrongpassword", current)).resolves.toBe(false)

    const legacy = "$sha256$" + "a".repeat(32) + ":" + createHash("sha256")
      .update("a".repeat(32) + "legacy-password")
      .digest("hex")
    expect(needsPasswordRehash(legacy)).toBe(true)
    await expect(verifyPasswordAsync("legacy-password", legacy)).resolves.toBe(true)
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

  it("rejects malformed or attacker-controlled scrypt parameters", () => {
    const salt = "a".repeat(32)
    const key = "b".repeat(128)

    expect(isPasswordHashed(`$scrypt$1073741824$8$5$${salt}$${key}`)).toBe(false)
    expect(isPasswordHashed(`$scrypt$16384$8$5$short$${key}`)).toBe(false)
    expect(verifyPassword("password", `$scrypt$1073741824$8$5$${salt}$${key}`)).toBe(false)
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

  interface RequestOptions {
    authHeader?: string
    clientHeader?: string
    host?: string
    method?: string
    origin?: string
    forwardedFor?: string
    forwardedProto?: string
    cookie?: string
    userAgent?: string
    fetchSite?: string
  }

  function mockReq(ip: string, url: string, opts: RequestOptions = {}): IncomingMessage {
    const headers: Record<string, string> = {
      host: opts.host ?? (ip === "127.0.0.1" ? "127.0.0.1:19384" : "cogpit.local:19384"),
    }
    if (opts.authHeader) headers.authorization = opts.authHeader
    if (opts.clientHeader) headers["x-cogpit-client"] = opts.clientHeader
    if (opts.origin) headers.origin = opts.origin
    if (opts.forwardedFor) headers["x-forwarded-for"] = opts.forwardedFor
    if (opts.forwardedProto) headers["x-forwarded-proto"] = opts.forwardedProto
    if (opts.cookie) headers.cookie = opts.cookie
    if (opts.userAgent) headers["user-agent"] = opts.userAgent
    if (opts.fetchSite) headers["sec-fetch-site"] = opts.fetchSite
    return {
      socket: { remoteAddress: ip },
      url,
      method: opts.method ?? "GET",
      headers,
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

  function run(url: string, opts: RequestOptions & { ip?: string } = {}) {
    const req = mockReq(opts.ip ?? REMOTE_IP, url, opts)
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

  it("rejects an unforwarded loopback request carrying a non-loopback Host", () => {
    const r = run("/api/projects", { ip: "127.0.0.1", host: "attacker.example:19384" })
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(403)
    expect(r.body).toContain("Untrusted local host")
  })

  it("does not grant local trust to a forwarded loopback request", () => {
    const r = run("/api/projects", {
      ip: "127.0.0.1",
      forwardedFor: "203.0.113.8",
    })
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(401)
  })

  it("accepts a valid token through a loopback reverse proxy", () => {
    const token = createSessionToken("203.0.113.8")
    const r = run("/api/projects", {
      ip: "127.0.0.1",
      forwardedFor: "203.0.113.8",
      authHeader: `Bearer ${token}`,
    })
    expect(r.next).toHaveBeenCalledOnce()
  })

  it("rejects a cross-origin local mutation without the client header", () => {
    const r = run("/api/send-message", {
      ip: "127.0.0.1",
      method: "POST",
      origin: "https://attacker.example",
    })
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(403)
    expect(r.body).toContain("Untrusted request source")
  })

  it("allows a same-origin local browser mutation", () => {
    const r = run("/api/send-message", {
      ip: "127.0.0.1",
      method: "POST",
      origin: "http://127.0.0.1:19384",
    })
    expect(r.next).toHaveBeenCalledOnce()
  })

  it("keeps headerless non-browser localhost API clients compatible", () => {
    const r = run("/api/send-message", { ip: "127.0.0.1", method: "POST" })
    expect(r.next).toHaveBeenCalledOnce()
  })

  it("does not let a client header override a cross-origin mutation", () => {
    const r = run("/api/send-message", {
      ip: "127.0.0.1",
      method: "POST",
      origin: "https://attacker.example",
      clientHeader: "1",
    })
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(403)
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

  it("allows a remote request carrying a valid HttpOnly-cookie session", () => {
    const token = createSessionToken(REMOTE_IP, "Browser/1")
    const r = run("/api/projects", {
      cookie: `__Host-cogpit_session=${token}`,
      userAgent: "Browser/1",
    })
    expect(r.next).toHaveBeenCalledOnce()
  })

  it("binds a browser cookie session to its original user agent", () => {
    const token = createSessionToken(REMOTE_IP, "Browser/1")
    const r = run("/api/projects", {
      cookie: `__Host-cogpit_session=${token}`,
      userAgent: "Attacker/1",
    })
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(401)
  })

  it("rejects query-string tokens for HTTP endpoints", () => {
    const token = createSessionToken(REMOTE_IP)
    const r = run(`/api/projects?token=${token}`)
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(401)
  })

  it("accepts a same-origin cookie-authenticated remote mutation", () => {
    const token = createSessionToken(REMOTE_IP, "Browser/1")
    const r = run("/api/send-message", {
      method: "POST",
      host: "cogpit.example",
      origin: "https://cogpit.example",
      forwardedProto: "https",
      fetchSite: "same-origin",
      clientHeader: "1",
      cookie: `__Host-cogpit_session=${token}`,
      userAgent: "Browser/1",
    })
    expect(r.next).toHaveBeenCalledOnce()
  })

  it("rejects a cross-origin remote mutation even with a valid bearer", () => {
    const token = createSessionToken(REMOTE_IP)
    const r = run("/api/send-message", {
      method: "POST",
      origin: "https://attacker.example",
      authHeader: `Bearer ${token}`,
      clientHeader: "1",
    })
    expect(r.next).not.toHaveBeenCalled()
    expect(r.statusCode).toBe(403)
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

describe("websocketUpgradeRejection", () => {
  function upgradeReq(headers: Record<string, string>, ip = "127.0.0.1"): IncomingMessage {
    return {
      headers,
      socket: { remoteAddress: ip },
    } as unknown as IncomingMessage
  }

  it("allows the same-origin browser client on a literal loopback host", () => {
    const req = upgradeReq({
      host: "127.0.0.1:19384",
      origin: "http://127.0.0.1:19384",
    })
    expect(websocketUpgradeRejection(req, new URL("http://localhost/__pty"))).toBeNull()
  })

  it("rejects cross-site WebSocket hijacking over a loopback socket", () => {
    const req = upgradeReq({
      host: "127.0.0.1:19384",
      origin: "https://attacker.example",
    })
    expect(websocketUpgradeRejection(req, new URL("http://localhost/__pty"))).toBe(403)
  })

  it("rejects DNS-rebinding hosts even when Origin and Host match", () => {
    const req = upgradeReq({
      host: "attacker.example:19384",
      origin: "http://attacker.example:19384",
    })
    expect(websocketUpgradeRejection(req, new URL("http://localhost/__pty"))).toBe(403)
  })

  it("allows headerless non-browser WebSocket clients on literal loopback", () => {
    const req = upgradeReq({ host: "localhost:19384" })
    expect(websocketUpgradeRejection(req, new URL("http://localhost/__pty"))).toBeNull()
  })

  it("requires a token when a loopback WebSocket came through a reverse proxy", () => {
    const req = upgradeReq({
      host: "localhost:19384",
      "x-forwarded-for": "203.0.113.8",
    })
    expect(websocketUpgradeRejection(req, new URL("http://localhost/__pty"))).toBe(401)
  })

  it("accepts an authenticated WebSocket through a loopback reverse proxy", () => {
    const token = createSessionToken("203.0.113.8")
    const req = upgradeReq({
      host: "localhost:19384",
      "x-forwarded-for": "203.0.113.8",
    })
    expect(
      websocketUpgradeRejection(req, new URL(`http://localhost/__pty?token=${token}`)),
    ).toBeNull()
  })

  it("accepts a same-origin remote browser WebSocket with its session cookie", () => {
    const token = createSessionToken("203.0.113.8", "Browser/1")
    const req = upgradeReq({
      host: "cogpit.example",
      origin: "https://cogpit.example",
      cookie: `__Host-cogpit_session=${token}`,
      "user-agent": "Browser/1",
      "x-forwarded-proto": "https",
    }, "127.0.0.1")
    expect(websocketUpgradeRejection(req, new URL("https://cogpit.example/__pty"))).toBeNull()
  })

  it("does not accept a browser query token in place of the HttpOnly cookie", () => {
    const token = createSessionToken("203.0.113.8", "Browser/1")
    const req = upgradeReq({
      host: "cogpit.example",
      origin: "https://cogpit.example",
      "user-agent": "Browser/1",
      "x-forwarded-proto": "https",
    }, "127.0.0.1")
    expect(
      websocketUpgradeRejection(req, new URL(`https://cogpit.example/__pty?token=${token}`)),
    ).toBe(401)
  })

  it("only classifies literal, unforwarded loopback requests as directly trusted", () => {
    expect(isTrustedDirectLocalRequest(upgradeReq({ host: "localhost:19384" }))).toBe(true)
    expect(isTrustedDirectLocalRequest(upgradeReq({
      host: "localhost:19384",
      forwarded: "for=203.0.113.8;proto=https",
    }))).toBe(false)
    expect(isTrustedDirectLocalRequest(upgradeReq({ host: "cogpit.example" }))).toBe(false)
  })
})
