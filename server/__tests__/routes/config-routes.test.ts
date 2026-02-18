// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"
import type { NetworkInterfaceInfo } from "node:os"

vi.mock("../../helpers", () => ({
  refreshDirs: vi.fn(),
  isLocalRequest: vi.fn(),
  isRateLimited: vi.fn(),
  createSessionToken: vi.fn(),
  verifyPassword: vi.fn(),
  hashPassword: vi.fn(),
  validatePasswordStrength: vi.fn(),
  revokeAllSessions: vi.fn(),
}))

vi.mock("../../config", () => ({
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
  validateClaudeDir: vi.fn(),
}))

vi.mock("node:os", () => ({
  networkInterfaces: vi.fn(),
}))

import {
  refreshDirs,
  isLocalRequest,
  isRateLimited,
  createSessionToken,
  verifyPassword,
  hashPassword,
  validatePasswordStrength,
  revokeAllSessions,
} from "../../helpers"
import { getConfig, saveConfig, validateClaudeDir } from "../../config"
import { networkInterfaces } from "node:os"

const mockedIsLocalRequest = vi.mocked(isLocalRequest)
const mockedIsRateLimited = vi.mocked(isRateLimited)
const mockedCreateSessionToken = vi.mocked(createSessionToken)
const mockedVerifyPassword = vi.mocked(verifyPassword)
const mockedHashPassword = vi.mocked(hashPassword)
const mockedValidatePasswordStrength = vi.mocked(validatePasswordStrength)
const mockedRevokeAllSessions = vi.mocked(revokeAllSessions)
const mockedRefreshDirs = vi.mocked(refreshDirs)
const mockedGetConfig = vi.mocked(getConfig)
const mockedSaveConfig = vi.mocked(saveConfig)
const mockedValidateClaudeDir = vi.mocked(validateClaudeDir)
const mockedNetworkInterfaces = vi.mocked(networkInterfaces)

import type { UseFn, Middleware } from "../../helpers"
import { registerConfigRoutes } from "../../routes/config"

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
  return { req, res, next, sendBody }
}

describe("config routes", () => {
  let handlers: Map<string, Middleware>

  beforeEach(() => {
    vi.resetAllMocks()
    handlers = new Map()
    const use: UseFn = (path: string, handler: Middleware) => {
      handlers.set(path, handler)
    }
    registerConfigRoutes(use)
  })

  // ── GET /api/network-info ─────────────────────────────────────────────

  describe("GET /api/network-info", () => {
    it("calls next for non-GET methods", () => {
      const handler = handlers.get("/api/network-info")
      const { req, res, next } = createMockReqRes("POST", "/")
      handler(req, res, next)
      expect(next).toHaveBeenCalled()
    })

    it("returns enabled:false when network access is off", () => {
      const handler = handlers.get("/api/network-info")
      const { req, res, next } = createMockReqRes("GET", "/")
      mockedGetConfig.mockReturnValueOnce(null)

      handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response.enabled).toBe(false)
    })

    it("returns enabled:false when no password set", () => {
      const handler = handlers.get("/api/network-info")
      const { req, res, next } = createMockReqRes("GET", "/")
      mockedGetConfig.mockReturnValueOnce({ claudeDir: "/x", networkAccess: true })

      handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response.enabled).toBe(false)
    })

    it("returns network info when enabled", () => {
      const handler = handlers.get("/api/network-info")
      const { req, res, next } = createMockReqRes("GET", "/")
      mockedGetConfig.mockReturnValueOnce({
        claudeDir: "/x", networkAccess: true, networkPassword: "hashed",
      })
      mockedNetworkInterfaces.mockReturnValueOnce({
        eth0: [{ family: "IPv4", internal: false, address: "192.168.1.50" }] as unknown as NetworkInterfaceInfo[],
      })

      handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response.enabled).toBe(true)
      expect(response.host).toBe("192.168.1.50")
      expect(response.port).toBe(19384)
      expect(response.url).toBe("http://192.168.1.50:19384")
    })
  })

  // ── POST /api/auth/verify ─────────────────────────────────────────────

  describe("POST /api/auth/verify", () => {
    it("calls next for non-POST methods", () => {
      const handler = handlers.get("/api/auth/verify")
      const { req, res, next } = createMockReqRes("GET", "/")
      handler(req, res, next)
      expect(next).toHaveBeenCalled()
    })

    it("returns valid:true for local requests", () => {
      const handler = handlers.get("/api/auth/verify")
      const { req, res, next } = createMockReqRes("POST", "/")
      mockedIsLocalRequest.mockReturnValueOnce(true)

      handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response.valid).toBe(true)
    })

    it("returns 429 when rate limited", () => {
      const handler = handlers.get("/api/auth/verify")
      const { req, res, next } = createMockReqRes("POST", "/")
      mockedIsLocalRequest.mockReturnValueOnce(false)
      mockedIsRateLimited.mockReturnValueOnce(true)

      handler(req, res, next)

      expect(res._getStatus()).toBe(429)
      const response = JSON.parse(res._getData())
      expect(response.valid).toBe(false)
    })

    it("returns 403 when network access disabled", () => {
      const handler = handlers.get("/api/auth/verify")
      const { req, res, next } = createMockReqRes("POST", "/")
      mockedIsLocalRequest.mockReturnValueOnce(false)
      mockedIsRateLimited.mockReturnValueOnce(false)
      mockedGetConfig.mockReturnValueOnce(null)

      handler(req, res, next)

      expect(res._getStatus()).toBe(403)
    })

    it("returns 401 when no password provided", () => {
      const handler = handlers.get("/api/auth/verify")
      const { req, res, next } = createMockReqRes("POST", "/")
      mockedIsLocalRequest.mockReturnValueOnce(false)
      mockedIsRateLimited.mockReturnValueOnce(false)
      mockedGetConfig.mockReturnValueOnce({
        claudeDir: "/x", networkAccess: true, networkPassword: "hashed",
      })

      handler(req, res, next)

      expect(res._getStatus()).toBe(401)
      expect(JSON.parse(res._getData()).error).toContain("Password required")
    })

    it("returns 401 for invalid password", () => {
      const handler = handlers.get("/api/auth/verify")
      const { req, res, next } = createMockReqRes("POST", "/")
      req.headers.authorization = "Bearer wrongpass"
      mockedIsLocalRequest.mockReturnValueOnce(false)
      mockedIsRateLimited.mockReturnValueOnce(false)
      mockedGetConfig.mockReturnValueOnce({
        claudeDir: "/x", networkAccess: true, networkPassword: "hashed",
      })
      mockedVerifyPassword.mockReturnValueOnce(false)

      handler(req, res, next)

      expect(res._getStatus()).toBe(401)
      expect(JSON.parse(res._getData()).error).toContain("Invalid password")
    })

    it("returns session token for valid password", () => {
      const handler = handlers.get("/api/auth/verify")
      const { req, res, next } = createMockReqRes("POST", "/")
      req.headers.authorization = "Bearer correctpass"
      mockedIsLocalRequest.mockReturnValueOnce(false)
      mockedIsRateLimited.mockReturnValueOnce(false)
      mockedGetConfig.mockReturnValueOnce({
        claudeDir: "/x", networkAccess: true, networkPassword: "hashed",
      })
      mockedVerifyPassword.mockReturnValueOnce(true)
      mockedCreateSessionToken.mockReturnValueOnce("session-token-abc")

      handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response.valid).toBe(true)
      expect(response.token).toBe("session-token-abc")
    })
  })

  // ── GET /api/config/validate ──────────────────────────────────────────

  describe("GET /api/config/validate", () => {
    it("calls next for non-GET methods", async () => {
      const handler = handlers.get("/api/config/validate")
      const { req, res, next } = createMockReqRes("GET", "/")
      // No path param => 400, not next
      await handler(req, res, next)
      expect(res._getStatus()).toBe(400)
    })

    it("returns 400 when path param missing", async () => {
      const handler = handlers.get("/api/config/validate")
      const { req, res, next } = createMockReqRes("GET", "?other=x")
      await handler(req, res, next)
      expect(res._getStatus()).toBe(400)
    })

    it("returns validation result for valid path", async () => {
      const handler = handlers.get("/api/config/validate")
      const { req, res, next } = createMockReqRes("GET", "?path=/home/.claude")
      mockedValidateClaudeDir.mockResolvedValueOnce({
        valid: true, resolved: "/home/.claude",
      })

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response.valid).toBe(true)
      expect(response.resolved).toBe("/home/.claude")
    })

    it("returns validation error for invalid path", async () => {
      const handler = handlers.get("/api/config/validate")
      const { req, res, next } = createMockReqRes("GET", "?path=/nonexistent")
      mockedValidateClaudeDir.mockResolvedValueOnce({
        valid: false, error: "Path does not exist",
      })

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response.valid).toBe(false)
      expect(response.error).toContain("does not exist")
    })
  })

  // ── GET /api/config ───────────────────────────────────────────────────

  describe("GET /api/config", () => {
    it("returns null when no config", async () => {
      const handler = handlers.get("/api/config")
      const { req, res, next } = createMockReqRes("GET", "/")
      mockedGetConfig.mockReturnValueOnce(null)

      await handler(req, res, next)

      expect(JSON.parse(res._getData())).toBeNull()
    })

    it("returns config with password masked as 'set'", async () => {
      const handler = handlers.get("/api/config")
      const { req, res, next } = createMockReqRes("GET", "/")
      mockedGetConfig.mockReturnValueOnce({
        claudeDir: "/home/.claude",
        networkAccess: true,
        networkPassword: "hashed:password",
      })

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response.claudeDir).toBe("/home/.claude")
      expect(response.networkAccess).toBe(true)
      expect(response.networkPassword).toBe("set")
    })

    it("returns null networkPassword when not set", async () => {
      const handler = handlers.get("/api/config")
      const { req, res, next } = createMockReqRes("GET", "/")
      mockedGetConfig.mockReturnValueOnce({
        claudeDir: "/home/.claude",
        networkAccess: false,
      })

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response.networkPassword).toBeNull()
    })

    it("calls next for non-root GET paths", async () => {
      const handler = handlers.get("/api/config")
      const { req, res, next } = createMockReqRes("GET", "/subpath")

      await handler(req, res, next)

      expect(next).toHaveBeenCalled()
    })
  })

  // ── POST /api/config ──────────────────────────────────────────────────

  describe("POST /api/config", () => {
    it("returns 400 when claudeDir is missing", async () => {
      const handler = handlers.get("/api/config")
      const body = JSON.stringify({ other: "value" })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/", body)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res._getStatus()).toBe(400)
      })
      expect(JSON.parse(res._getData()).error).toContain("claudeDir")
    })

    it("returns 400 when claudeDir validation fails", async () => {
      const handler = handlers.get("/api/config")
      const body = JSON.stringify({ claudeDir: "/bad/path" })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/", body)
      mockedValidateClaudeDir.mockResolvedValueOnce({
        valid: false, error: "Not a directory",
      })

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res._getStatus()).toBe(400)
      })
      expect(JSON.parse(res._getData()).error).toContain("Not a directory")
    })

    it("saves config successfully", async () => {
      const handler = handlers.get("/api/config")
      const body = JSON.stringify({ claudeDir: "/home/.claude" })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/", body)
      mockedValidateClaudeDir.mockResolvedValueOnce({
        valid: true, resolved: "/home/.claude",
      })
      mockedGetConfig.mockReturnValueOnce(null)
      mockedSaveConfig.mockResolvedValueOnce(undefined)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled()
      })
      const response = JSON.parse(res._getData())
      expect(response.success).toBe(true)
      expect(mockedSaveConfig).toHaveBeenCalled()
      expect(mockedRefreshDirs).toHaveBeenCalled()
    })

    it("returns 400 for weak password", async () => {
      const handler = handlers.get("/api/config")
      const body = JSON.stringify({
        claudeDir: "/home/.claude",
        networkAccess: true,
        networkPassword: "short",
      })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/", body)
      mockedValidateClaudeDir.mockResolvedValueOnce({
        valid: true, resolved: "/home/.claude",
      })
      mockedGetConfig.mockReturnValueOnce(null)
      mockedValidatePasswordStrength.mockReturnValueOnce("Password must be at least 12 characters")

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res._getStatus()).toBe(400)
      })
      expect(JSON.parse(res._getData()).error).toContain("12 characters")
    })

    it("hashes password and revokes sessions when password changes", async () => {
      const handler = handlers.get("/api/config")
      const body = JSON.stringify({
        claudeDir: "/home/.claude",
        networkAccess: true,
        networkPassword: "validpassword123",
      })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/", body)
      mockedValidateClaudeDir.mockResolvedValueOnce({
        valid: true, resolved: "/home/.claude",
      })
      mockedGetConfig.mockReturnValueOnce({
        claudeDir: "/home/.claude", networkAccess: true, networkPassword: "old-hash",
      })
      mockedValidatePasswordStrength.mockReturnValueOnce(null)
      mockedHashPassword.mockReturnValueOnce("new-salt:new-hash")
      mockedSaveConfig.mockResolvedValueOnce(undefined)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled()
      })
      expect(mockedRevokeAllSessions).toHaveBeenCalled()
      expect(mockedHashPassword).toHaveBeenCalledWith("validpassword123")
    })

    it("returns 400 when network access enabled without password", async () => {
      const handler = handlers.get("/api/config")
      const body = JSON.stringify({
        claudeDir: "/home/.claude",
        networkAccess: true,
      })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/", body)
      mockedValidateClaudeDir.mockResolvedValueOnce({
        valid: true, resolved: "/home/.claude",
      })
      mockedGetConfig.mockReturnValueOnce(null)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res._getStatus()).toBe(400)
      })
      expect(JSON.parse(res._getData()).error).toContain("Password required")
    })

    it("revokes sessions when disabling network access", async () => {
      const handler = handlers.get("/api/config")
      const body = JSON.stringify({
        claudeDir: "/home/.claude",
        networkAccess: false,
      })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/", body)
      mockedValidateClaudeDir.mockResolvedValueOnce({
        valid: true, resolved: "/home/.claude",
      })
      mockedGetConfig.mockReturnValueOnce({
        claudeDir: "/home/.claude", networkAccess: true, networkPassword: "hashed",
      })
      mockedSaveConfig.mockResolvedValueOnce(undefined)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled()
      })
      expect(mockedRevokeAllSessions).toHaveBeenCalled()
    })

    it("returns 400 for invalid JSON body", async () => {
      const handler = handlers.get("/api/config")
      const { req, res, next, sendBody } = createMockReqRes("POST", "/", "not-json{")

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res._getStatus()).toBe(400)
      })
    })

    it("calls next for non-GET/POST methods", async () => {
      const handler = handlers.get("/api/config")
      const { req, res, next } = createMockReqRes("DELETE", "/")

      await handler(req, res, next)

      expect(next).toHaveBeenCalled()
    })
  })
})
