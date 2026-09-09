// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"
import type { NetworkInterfaceInfo } from "node:os"

vi.mock("../../helpers", () => ({
  refreshDirs: vi.fn(),
  isTrustedDirectLocalRequest: vi.fn(),
  hasTrustedMutationSource: vi.fn(),
  canIssueBrowserSession: vi.fn(),
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
}))

vi.mock("../../lib/rateLimit", () => ({ isRateLimited: vi.fn() }))

vi.mock("../../config", () => ({
  getConfig: vi.fn(),
  getConfiguredEditionValue: vi.fn(),
  saveConfig: vi.fn(),
  validateClaudeDir: vi.fn(),
}))

vi.mock("node:os", () => ({
  networkInterfaces: vi.fn(),
}))

import {
  refreshDirs,
  isTrustedDirectLocalRequest,
  hasTrustedMutationSource,
  canIssueBrowserSession,
  createSessionToken,
  getRequestSessionToken,
  setBrowserSessionCookie,
  clearBrowserSessionCookie,
  revokeSessionToken,
  verifyPasswordAsync,
  needsPasswordRehash,
  hashPassword,
  validatePasswordStrength,
  revokeAllSessions,
} from "../../helpers"
import { isRateLimited } from "../../lib/rateLimit"
import { getConfig, getConfiguredEditionValue, saveConfig, validateClaudeDir } from "../../config"
import { networkInterfaces } from "node:os"

const mockedIsTrustedDirectLocalRequest = vi.mocked(isTrustedDirectLocalRequest)
const mockedHasTrustedMutationSource = vi.mocked(hasTrustedMutationSource)
const mockedCanIssueBrowserSession = vi.mocked(canIssueBrowserSession)
const mockedIsRateLimited = vi.mocked(isRateLimited)
const mockedCreateSessionToken = vi.mocked(createSessionToken)
const mockedGetRequestSessionToken = vi.mocked(getRequestSessionToken)
const mockedSetBrowserSessionCookie = vi.mocked(setBrowserSessionCookie)
const mockedClearBrowserSessionCookie = vi.mocked(clearBrowserSessionCookie)
const mockedRevokeSessionToken = vi.mocked(revokeSessionToken)
const mockedVerifyPasswordAsync = vi.mocked(verifyPasswordAsync)
const mockedNeedsPasswordRehash = vi.mocked(needsPasswordRehash)
const mockedHashPassword = vi.mocked(hashPassword)
const mockedValidatePasswordStrength = vi.mocked(validatePasswordStrength)
const mockedRevokeAllSessions = vi.mocked(revokeAllSessions)
const mockedRefreshDirs = vi.mocked(refreshDirs)
const mockedGetConfig = vi.mocked(getConfig)
const mockedGetConfiguredEditionValue = vi.mocked(getConfiguredEditionValue)
const mockedSaveConfig = vi.mocked(saveConfig)
const mockedValidateClaudeDir = vi.mocked(validateClaudeDir)
const mockedNetworkInterfaces = vi.mocked(networkInterfaces)

import type { Middleware } from "../../helpers"
import { collectRoutes, createMockReqRes, getRouteHandler } from "../http-fixtures"
import { registerConfigRoutes } from "../../routes/config"

/** Every config route here is reached from a LAN client on the default port. */
function createLanReqRes(method: string, url: string, body?: string) {
  return createMockReqRes(method, url, { body, remoteAddress: "192.168.1.100", socketPort: 19384 })
}

describe("config routes", () => {
  let handlers: Map<string, Middleware>

  beforeEach(() => {
    vi.resetAllMocks()
    mockedHasTrustedMutationSource.mockReturnValue(true)
    mockedCanIssueBrowserSession.mockReturnValue(true)
    mockedGetConfiguredEditionValue.mockReturnValue(undefined)
    handlers = collectRoutes(registerConfigRoutes)
  })

  // ── GET /api/network-info ─────────────────────────────────────────────

  describe("GET /api/network-info", () => {
    it("calls next for non-GET methods", () => {
      const handler = getRouteHandler(handlers, "/api/network-info")
      const { req, res, next } = createLanReqRes("POST", "/")
      handler(req, res, next)
      expect(next).toHaveBeenCalled()
    })

    it("returns enabled:false when network access is off", () => {
      const handler = getRouteHandler(handlers, "/api/network-info")
      const { req, res, next } = createLanReqRes("GET", "/")
      mockedGetConfig.mockReturnValueOnce(null)

      handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response.enabled).toBe(false)
    })

    it("returns enabled:false when no password set", () => {
      const handler = getRouteHandler(handlers, "/api/network-info")
      const { req, res, next } = createLanReqRes("GET", "/")
      mockedGetConfig.mockReturnValueOnce({ claudeDir: "/x", networkAccess: true })

      handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response.enabled).toBe(false)
    })

    it("returns network info when enabled", () => {
      const handler = getRouteHandler(handlers, "/api/network-info")
      const { req, res, next } = createLanReqRes("GET", "/")
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
    it("calls next for non-POST methods", async () => {
      const handler = getRouteHandler(handlers, "/api/auth/verify")
      const { req, res, next } = createLanReqRes("GET", "/")
      await handler(req, res, next)
      expect(next).toHaveBeenCalled()
    })

    it("returns valid:true for directly trusted local requests", async () => {
      const handler = getRouteHandler(handlers, "/api/auth/verify")
      const { req, res, next } = createLanReqRes("POST", "/")
      mockedIsTrustedDirectLocalRequest.mockReturnValueOnce(true)

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response.valid).toBe(true)
    })

    it("returns 429 when rate limited", async () => {
      const handler = getRouteHandler(handlers, "/api/auth/verify")
      const { req, res, next } = createLanReqRes("POST", "/")
      mockedIsTrustedDirectLocalRequest.mockReturnValueOnce(false)
      mockedIsRateLimited.mockReturnValueOnce(true)

      await handler(req, res, next)

      expect(res._getStatus()).toBe(429)
      const response = JSON.parse(res._getData())
      expect(response.valid).toBe(false)
    })

    it("returns 403 when network access disabled", async () => {
      const handler = getRouteHandler(handlers, "/api/auth/verify")
      const { req, res, next } = createLanReqRes("POST", "/")
      mockedIsTrustedDirectLocalRequest.mockReturnValueOnce(false)
      mockedIsRateLimited.mockReturnValueOnce(false)
      mockedGetConfig.mockReturnValueOnce(null)

      await handler(req, res, next)

      expect(res._getStatus()).toBe(403)
    })

    it("returns 401 when no password provided", async () => {
      const handler = getRouteHandler(handlers, "/api/auth/verify")
      const { req, res, next } = createLanReqRes("POST", "/")
      mockedIsTrustedDirectLocalRequest.mockReturnValueOnce(false)
      mockedIsRateLimited.mockReturnValueOnce(false)
      mockedGetConfig.mockReturnValueOnce({
        claudeDir: "/x", networkAccess: true, networkPassword: "hashed",
      })

      await handler(req, res, next)

      expect(res._getStatus()).toBe(401)
      expect(JSON.parse(res._getData()).error).toContain("Password required")
    })

    it("returns 401 for invalid password", async () => {
      const handler = getRouteHandler(handlers, "/api/auth/verify")
      const { req, res, next } = createLanReqRes("POST", "/")
      req.headers.authorization = "Bearer wrongpass"
      mockedIsTrustedDirectLocalRequest.mockReturnValueOnce(false)
      mockedIsRateLimited.mockReturnValueOnce(false)
      mockedGetConfig.mockReturnValueOnce({
        claudeDir: "/x", networkAccess: true, networkPassword: "hashed",
      })
      mockedVerifyPasswordAsync.mockResolvedValueOnce(false)

      await handler(req, res, next)

      expect(res._getStatus()).toBe(401)
      expect(JSON.parse(res._getData()).error).toContain("Invalid password")
    })

    it("does not mint a session for a verified legacy password below the current minimum", async () => {
      const handler = getRouteHandler(handlers, "/api/auth/verify")
      const { req, res, next } = createLanReqRes("POST", "/")
      req.headers.authorization = "Bearer short-but-correct"
      mockedIsTrustedDirectLocalRequest.mockReturnValueOnce(false)
      mockedGetConfig.mockReturnValueOnce({
        claudeDir: "/x", networkAccess: true, networkPassword: "legacy-hash",
      })
      mockedVerifyPasswordAsync.mockResolvedValueOnce(true)
      mockedValidatePasswordStrength.mockReturnValueOnce("Password must be at least 16 characters")

      await handler(req, res, next)

      expect(res._getStatus()).toBe(403)
      expect(JSON.parse(res._getData()).error).toContain("local Cogpit app")
      expect(mockedCreateSessionToken).not.toHaveBeenCalled()
    })

    it("returns session token for valid password", async () => {
      const handler = getRouteHandler(handlers, "/api/auth/verify")
      const { req, res, next } = createLanReqRes("POST", "/")
      req.headers.authorization = "Bearer correctpass"
      mockedIsTrustedDirectLocalRequest.mockReturnValueOnce(false)
      mockedIsRateLimited.mockReturnValueOnce(false)
      mockedGetConfig.mockReturnValueOnce({
        claudeDir: "/x", networkAccess: true, networkPassword: "hashed",
      })
      mockedVerifyPasswordAsync.mockResolvedValueOnce(true)
      mockedNeedsPasswordRehash.mockReturnValueOnce(false)
      mockedCreateSessionToken.mockReturnValueOnce("session-token-abc")

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response.valid).toBe(true)
      expect(response.token).toBe("session-token-abc")
    })

    it("sets an HttpOnly cookie and withholds the token body for secure browsers", async () => {
      const handler = getRouteHandler(handlers, "/api/auth/verify")
      const { req, res, next } = createLanReqRes("POST", "/")
      req.headers.authorization = "Bearer correctpass"
      req.headers["x-cogpit-client"] = "1"
      mockedIsTrustedDirectLocalRequest.mockReturnValueOnce(false)
      mockedGetConfig.mockReturnValueOnce({
        claudeDir: "/x", networkAccess: true, networkPassword: "hashed",
      })
      mockedVerifyPasswordAsync.mockResolvedValueOnce(true)
      mockedNeedsPasswordRehash.mockReturnValueOnce(false)
      mockedCreateSessionToken.mockReturnValueOnce("browser-session")

      await handler(req, res, next)

      expect(mockedSetBrowserSessionCookie).toHaveBeenCalledWith(res, "browser-session")
      expect(JSON.parse(res._getData())).toEqual({ valid: true })
    })

    it("refuses to issue a browser session over insecure transport", async () => {
      const handler = getRouteHandler(handlers, "/api/auth/verify")
      const { req, res, next } = createLanReqRes("POST", "/")
      req.headers["x-cogpit-client"] = "1"
      mockedIsTrustedDirectLocalRequest.mockReturnValueOnce(false)
      mockedCanIssueBrowserSession.mockReturnValueOnce(false)

      await handler(req, res, next)

      expect(res._getStatus()).toBe(426)
      expect(JSON.parse(res._getData()).error).toContain("HTTPS")
      expect(mockedVerifyPasswordAsync).not.toHaveBeenCalled()
    })

    it("rejects a cross-origin authentication attempt before password work", async () => {
      const handler = getRouteHandler(handlers, "/api/auth/verify")
      const { req, res, next } = createLanReqRes("POST", "/")
      mockedIsTrustedDirectLocalRequest.mockReturnValueOnce(false)
      mockedHasTrustedMutationSource.mockReturnValueOnce(false)

      await handler(req, res, next)

      expect(res._getStatus()).toBe(403)
      expect(mockedVerifyPasswordAsync).not.toHaveBeenCalled()
    })

    it("upgrades a legacy password hash after successful authentication", async () => {
      const handler = getRouteHandler(handlers, "/api/auth/verify")
      const { req, res, next } = createLanReqRes("POST", "/")
      req.headers.authorization = "Bearer correctpass"
      mockedIsTrustedDirectLocalRequest.mockReturnValueOnce(false)
      mockedIsRateLimited.mockReturnValueOnce(false)
      mockedGetConfig.mockReturnValueOnce({
        claudeDir: "/x",
        networkAccess: true,
        networkPassword: "$sha256$legacy:hash",
      })
      mockedVerifyPasswordAsync.mockResolvedValueOnce(true)
      mockedNeedsPasswordRehash.mockReturnValueOnce(true)
      mockedHashPassword.mockReturnValueOnce("$scrypt$current")
      mockedCreateSessionToken.mockReturnValueOnce("session-token-abc")

      await handler(req, res, next)

      expect(mockedSaveConfig).toHaveBeenCalledWith({
        claudeDir: "/x",
        networkAccess: true,
        networkPassword: "$scrypt$current",
      })
      expect(JSON.parse(res._getData())).toEqual({
        valid: true,
        token: "session-token-abc",
      })
    })

    it("caps concurrent password derivations and returns 429 when saturated", async () => {
      const handler = getRouteHandler(handlers, "/api/auth/verify")
      let resolveVerification!: (valid: boolean) => void
      const pendingVerification = new Promise<boolean>((resolve) => {
        resolveVerification = resolve
      })
      mockedIsTrustedDirectLocalRequest.mockReturnValue(false)
      mockedIsRateLimited.mockReturnValue(false)
      mockedGetConfig.mockReturnValue({
        claudeDir: "/x", networkAccess: true, networkPassword: "hashed",
      })
      mockedVerifyPasswordAsync.mockReturnValue(pendingVerification)

      const attempts = Array.from({ length: 3 }, () => {
        const attempt = createLanReqRes("POST", "/")
        attempt.req.headers.authorization = "Bearer password"
        return attempt
      })
      const first = handler(attempts[0].req, attempts[0].res, attempts[0].next)
      const second = handler(attempts[1].req, attempts[1].res, attempts[1].next)
      await handler(attempts[2].req, attempts[2].res, attempts[2].next)

      expect(attempts[2].res._getStatus()).toBe(429)
      expect(JSON.parse(attempts[2].res._getData()).error).toContain("busy")

      resolveVerification(false)
      await Promise.all([first, second])
    })
  })

  describe("browser session routes", () => {
    it("reports an authenticated session without exposing its token", () => {
      const handler = getRouteHandler(handlers, "/api/auth/session")
      const { req, res, next } = createLanReqRes("GET", "/")
      handler(req, res, next)
      expect(JSON.parse(res._getData())).toEqual({ authenticated: true })
      expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store")
    })

    it("revokes only the current session and expires its cookie", async () => {
      const handler = getRouteHandler(handlers, "/api/auth/logout")
      const { req, res, next } = createLanReqRes("POST", "/")
      mockedGetRequestSessionToken.mockReturnValueOnce("current-session")

      await handler(req, res, next)

      expect(mockedRevokeSessionToken).toHaveBeenCalledWith("current-session")
      expect(mockedClearBrowserSessionCookie).toHaveBeenCalledWith(res)
      expect(JSON.parse(res._getData())).toEqual({ valid: true })
    })
  })

  // ── GET /api/config/validate ──────────────────────────────────────────

  describe("GET /api/config/validate", () => {
    it("calls next for non-GET methods", async () => {
      const handler = getRouteHandler(handlers, "/api/config/validate")
      const { req, res, next } = createLanReqRes("GET", "/")
      // No path param => 400, not next
      await handler(req, res, next)
      expect(res._getStatus()).toBe(400)
    })

    it("returns 400 when path param missing", async () => {
      const handler = getRouteHandler(handlers, "/api/config/validate")
      const { req, res, next } = createLanReqRes("GET", "?other=x")
      await handler(req, res, next)
      expect(res._getStatus()).toBe(400)
    })

    it("returns validation result for valid path", async () => {
      const handler = getRouteHandler(handlers, "/api/config/validate")
      const { req, res, next } = createLanReqRes("GET", "?path=/home/.claude")
      mockedValidateClaudeDir.mockResolvedValueOnce({
        valid: true, resolved: "/home/.claude",
      })

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response.valid).toBe(true)
      expect(response.resolved).toBe("/home/.claude")
    })

    it("returns validation error for invalid path", async () => {
      const handler = getRouteHandler(handlers, "/api/config/validate")
      const { req, res, next } = createLanReqRes("GET", "?path=/nonexistent")
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
      const handler = getRouteHandler(handlers, "/api/config")
      const { req, res, next } = createLanReqRes("GET", "/")
      mockedGetConfig.mockReturnValueOnce(null)

      await handler(req, res, next)

      expect(JSON.parse(res._getData())).toBeNull()
    })

    it("returns config with password masked as 'set'", async () => {
      const handler = getRouteHandler(handlers, "/api/config")
      const { req, res, next } = createLanReqRes("GET", "/")
      mockedGetConfig.mockReturnValueOnce({
        claudeDir: "/home/.claude",
        networkAccess: true,
        networkPassword: "hashed:password",
        terminalApp: "Ghostty",
        editorApp: "Visual Studio Code",
      })

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response.claudeDir).toBe("/home/.claude")
      expect(response.networkAccess).toBe(true)
      expect(response.networkPassword).toBe("set")
      expect(response.terminalApp).toBe("Ghostty")
      expect(response.editorApp).toBe("Visual Studio Code")
      expect(response.useBuiltInEditor).toBe(false)
    })

    it("reports the built-in editor preference", async () => {
      const handler = getRouteHandler(handlers, "/api/config")
      const { req, res, next } = createLanReqRes("GET", "/")
      mockedGetConfig.mockReturnValueOnce({
        claudeDir: "/home/.claude",
        useBuiltInEditor: true,
      })

      await handler(req, res, next)

      expect(JSON.parse(res._getData()).useBuiltInEditor).toBe(true)
    })

    it("reports the executable choice, defaulting to auto", async () => {
      const handler = getRouteHandler(handlers, "/api/config")
      const first = createLanReqRes("GET", "/")
      mockedGetConfig.mockReturnValueOnce({ claudeDir: "/home/.claude" })
      await handler(first.req, first.res, first.next)
      expect(JSON.parse(first.res._getData()).agentExecutable).toEqual({ source: "auto" })

      const second = createLanReqRes("GET", "/")
      mockedGetConfig.mockReturnValueOnce({
        claudeDir: "/home/.claude",
        agentExecutable: { source: "custom", path: "/opt/claude" },
      })
      await handler(second.req, second.res, second.next)
      expect(JSON.parse(second.res._getData()).agentExecutable).toEqual({
        source: "custom",
        path: "/opt/claude",
      })
    })

    it("returns null networkPassword when not set", async () => {
      const handler = getRouteHandler(handlers, "/api/config")
      const { req, res, next } = createLanReqRes("GET", "/")
      mockedGetConfig.mockReturnValueOnce({
        claudeDir: "/home/.claude",
        networkAccess: false,
      })

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response.networkPassword).toBeNull()
    })

    it("identifies an auto-bootstrapped Codex-only configuration", async () => {
      const handler = getRouteHandler(handlers, "/api/config")
      const { req, res, next } = createLanReqRes("GET", "/")
      mockedGetConfig.mockReturnValueOnce({
        claudeDir: "/home/.claude",
        defaultAgent: "codex",
        claudeDirIsPlaceholder: true,
      })

      await handler(req, res, next)

      expect(JSON.parse(res._getData()).mode).toBe("codex")
    })

    it("identifies an auto-bootstrapped Copilot-only configuration", async () => {
      const handler = getRouteHandler(handlers, "/api/config")
      const { req, res, next } = createLanReqRes("GET", "/")
      mockedGetConfig.mockReturnValueOnce({
        claudeDir: "/home/.claude",
        defaultAgent: "copilot",
        claudeDirIsPlaceholder: true,
      })

      await handler(req, res, next)

      expect(JSON.parse(res._getData()).mode).toBe("copilot")
    })

    it("calls next for non-root GET paths", async () => {
      const handler = getRouteHandler(handlers, "/api/config")
      const { req, res, next } = createLanReqRes("GET", "/subpath")

      await handler(req, res, next)

      expect(next).toHaveBeenCalled()
    })
  })

  // ── POST /api/config ──────────────────────────────────────────────────

  describe("POST /api/config", () => {
    it("returns 400 when claudeDir is missing", async () => {
      const handler = getRouteHandler(handlers, "/api/config")
      const body = JSON.stringify({ other: "value" })
      const { req, res, next, sendBody } = createLanReqRes("POST", "/", body)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res._getStatus()).toBe(400)
      })
      expect(JSON.parse(res._getData()).error).toContain("claudeDir")
    })

    it("returns 400 when claudeDir validation fails", async () => {
      const handler = getRouteHandler(handlers, "/api/config")
      const body = JSON.stringify({ claudeDir: "/bad/path" })
      const { req, res, next, sendBody } = createLanReqRes("POST", "/", body)
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
      const handler = getRouteHandler(handlers, "/api/config")
      const body = JSON.stringify({ claudeDir: "/home/.claude" })
      const { req, res, next, sendBody } = createLanReqRes("POST", "/", body)
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

    it("saves unrelated settings for an external-only config without requiring Claude history", async () => {
      const handler = getRouteHandler(handlers, "/api/config")
      const body = JSON.stringify({
        claudeDir: "/home/.claude",
        terminalApp: "Ghostty",
        editorApp: "Visual Studio Code",
      })
      const { req, res, next, sendBody } = createLanReqRes("POST", "/", body)
      mockedGetConfig.mockReturnValueOnce({
        claudeDir: "/home/.claude",
        defaultAgent: "copilot",
        claudeDirIsPlaceholder: true,
      })
      mockedValidateClaudeDir.mockResolvedValueOnce({
        valid: false,
        error: "Path does not exist",
      })
      mockedSaveConfig.mockResolvedValueOnce(undefined)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled()
      })
      expect(res._getStatus()).toBe(200)
      expect(mockedSaveConfig).toHaveBeenCalledWith(expect.objectContaining({
        claudeDir: "/home/.claude",
        defaultAgent: "copilot",
        claudeDirIsPlaceholder: true,
        terminalApp: "Ghostty",
        editorApp: "Visual Studio Code",
      }))
    })

    it("persists the built-in editor preference", async () => {
      const handler = getRouteHandler(handlers, "/api/config")
      const body = JSON.stringify({ claudeDir: "/home/.claude", useBuiltInEditor: true })
      const { req, res, next, sendBody } = createLanReqRes("POST", "/", body)
      mockedValidateClaudeDir.mockResolvedValueOnce({ valid: true, resolved: "/home/.claude" })
      mockedSaveConfig.mockResolvedValueOnce(undefined)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled()
      })
      expect(mockedSaveConfig).toHaveBeenCalledWith(expect.objectContaining({
        useBuiltInEditor: true,
      }))
    })

    it("persists a well-formed executable choice and drops a malformed one", async () => {
      const handler = getRouteHandler(handlers, "/api/config")
      for (const [posted, saved] of [
        [{ source: "npm" }, { source: "npm" }],
        [{ source: "custom", path: " /opt/claude " }, { source: "custom", path: "/opt/claude" }],
        [{ source: "custom", path: "" }, undefined],
        [{ source: "auto" }, undefined],
        ["bundled", undefined],
      ] as const) {
        const body = JSON.stringify({ claudeDir: "/home/.claude", agentExecutable: posted })
        const { req, res, next, sendBody } = createLanReqRes("POST", "/", body)
        mockedValidateClaudeDir.mockResolvedValueOnce({ valid: true, resolved: "/home/.claude" })
        mockedSaveConfig.mockResolvedValueOnce(undefined)

        await handler(req, res, next)
        sendBody()
        await vi.waitFor(() => { expect(res.end).toHaveBeenCalled() })

        expect(mockedSaveConfig).toHaveBeenLastCalledWith(expect.objectContaining({
          agentExecutable: saved,
        }))
      }
    })

    it("carries the persisted edition through an unrelated config save", async () => {
      const handler = getRouteHandler(handlers, "/api/config")
      const body = JSON.stringify({ claudeDir: "/home/.claude", terminalApp: "Ghostty" })
      const { req, res, next, sendBody } = createLanReqRes("POST", "/", body)
      mockedValidateClaudeDir.mockResolvedValueOnce({
        valid: true, resolved: "/home/.claude",
      })
      mockedGetConfig.mockReturnValueOnce({
        claudeDir: "/home/.claude",
        edition: "team",
      })
      mockedSaveConfig.mockResolvedValueOnce(undefined)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled()
      })
      expect(mockedSaveConfig).toHaveBeenCalledWith(expect.objectContaining({
        edition: "team",
      }))
    })

    it("preserves an edition-only team bootstrap when the first full config is saved", async () => {
      const handler = getRouteHandler(handlers, "/api/config")
      const body = JSON.stringify({ claudeDir: "/home/.claude" })
      const { req, res, next, sendBody } = createLanReqRes("POST", "/", body)
      mockedGetConfig.mockReturnValueOnce(null)
      mockedGetConfiguredEditionValue.mockReturnValueOnce("team")
      mockedValidateClaudeDir.mockResolvedValueOnce({
        valid: true, resolved: "/home/.claude",
      })
      mockedSaveConfig.mockResolvedValueOnce(undefined)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => expect(res.end).toHaveBeenCalled())
      expect(mockedSaveConfig).toHaveBeenCalledWith(expect.objectContaining({
        claudeDir: "/home/.claude",
        edition: "team",
      }))
    })

    it("never adopts a client-supplied edition (file/env only)", async () => {
      const handler = getRouteHandler(handlers, "/api/config")
      const body = JSON.stringify({ claudeDir: "/home/.claude", edition: "team" })
      const { req, res, next, sendBody } = createLanReqRes("POST", "/", body)
      mockedValidateClaudeDir.mockResolvedValueOnce({
        valid: true, resolved: "/home/.claude",
      })
      mockedGetConfig.mockReturnValueOnce({ claudeDir: "/home/.claude" })
      mockedSaveConfig.mockResolvedValueOnce(undefined)

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled()
      })
      expect(mockedSaveConfig).toHaveBeenCalledOnce()
      expect(mockedSaveConfig.mock.calls[0][0].edition).toBeUndefined()
    })

    it("returns 400 for weak password", async () => {
      const handler = getRouteHandler(handlers, "/api/config")
      const body = JSON.stringify({
        claudeDir: "/home/.claude",
        networkAccess: true,
        networkPassword: "short",
      })
      const { req, res, next, sendBody } = createLanReqRes("POST", "/", body)
      mockedValidateClaudeDir.mockResolvedValueOnce({
        valid: true, resolved: "/home/.claude",
      })
      mockedGetConfig.mockReturnValueOnce(null)
      mockedValidatePasswordStrength.mockReturnValueOnce("Password must be at least 16 characters")

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res._getStatus()).toBe(400)
      })
      expect(JSON.parse(res._getData()).error).toContain("16 characters")
    })

    it("hashes password and revokes sessions when password changes", async () => {
      const handler = getRouteHandler(handlers, "/api/config")
      const body = JSON.stringify({
        claudeDir: "/home/.claude",
        networkAccess: true,
        networkPassword: "validpassword123",
      })
      const { req, res, next, sendBody } = createLanReqRes("POST", "/", body)
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
      const handler = getRouteHandler(handlers, "/api/config")
      const body = JSON.stringify({
        claudeDir: "/home/.claude",
        networkAccess: true,
      })
      const { req, res, next, sendBody } = createLanReqRes("POST", "/", body)
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
      const handler = getRouteHandler(handlers, "/api/config")
      const body = JSON.stringify({
        claudeDir: "/home/.claude",
        networkAccess: false,
      })
      const { req, res, next, sendBody } = createLanReqRes("POST", "/", body)
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
      const handler = getRouteHandler(handlers, "/api/config")
      const { req, res, next, sendBody } = createLanReqRes("POST", "/", "not-json{")

      await handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res._getStatus()).toBe(400)
      })
    })

    it("calls next for non-GET/POST methods", async () => {
      const handler = getRouteHandler(handlers, "/api/config")
      const { req, res, next } = createLanReqRes("DELETE", "/")

      await handler(req, res, next)

      expect(next).toHaveBeenCalled()
    })
  })
})
