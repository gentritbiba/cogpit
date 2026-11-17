// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockSharedAgentCheck = vi.hoisted(() => vi.fn())
vi.mock("../../agents/agentCheck", () => ({ sharedAgentCheck: mockSharedAgentCheck }))
const mockRestore = vi.hoisted(() => vi.fn())
vi.mock("../../agents/configRepair", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../agents/configRepair")>(),
  restoreReportedConfig: mockRestore,
}))

import { registerAgentCheckRoutes } from "../../routes/agent-check"
import { ConfigRestoreError } from "../../agents/configRepair"
import { collectRoutes, createMockReqRes, getRouteHandler } from "../http-fixtures"

const handler = getRouteHandler(collectRoutes(registerAgentCheckRoutes), "/api/agent-check")

describe("GET /api/agent-check", () => {
  beforeEach(() => {
    mockSharedAgentCheck.mockReset()
  })

  it("answers the shared check, never cached by the browser", async () => {
    const agents = [{ kind: "codex", binary: null }]
    mockSharedAgentCheck.mockResolvedValueOnce(agents)
    const { req, res, next } = createMockReqRes("GET", "/")

    await handler(req, res, next)

    expect(res._getStatus()).toBe(200)
    expect(res._getHeaders()["Cache-Control"]).toBe("no-store")
    const body = JSON.parse(res._getData())
    expect(body.agents).toEqual(agents)
    expect(Number.isNaN(Date.parse(body.checkedAt))).toBe(false)
  })

  it("leaves other methods and sub-paths alone", async () => {
    for (const [method, url] of [["POST", "/"], ["GET", "/claude"], ["GET", "/restore-config"]] as const) {
      const { req, res, next } = createMockReqRes(method, url)
      await handler(req, res, next)
      expect(next).toHaveBeenCalled()
    }
    expect(mockSharedAgentCheck).not.toHaveBeenCalled()
  })
})

describe("POST /api/agent-check/restore-config", () => {
  beforeEach(() => {
    mockRestore.mockReset()
  })

  it("restores the file a failed start named", async () => {
    mockRestore.mockResolvedValueOnce({ path: "/home/me/.claude.json", backupPath: "/home/me/.claude/backups/.claude.json.backup.1" })
    const { req, res, next, sendBody } = createMockReqRes("POST", "/restore-config", { body: JSON.stringify({ path: "/home/me/.claude.json" }) })

    await handler(req, res, next)
    sendBody()
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled())
    expect(res._getStatus()).toBe(200)

    expect(mockRestore).toHaveBeenCalledWith("/home/me/.claude.json")
    expect(JSON.parse(res._getData())).toEqual({ path: "/home/me/.claude.json", backupPath: "/home/me/.claude/backups/.claude.json.backup.1" })
  })

  it("answers a refusal with its status and reason", async () => {
    mockRestore.mockRejectedValueOnce(new ConfigRestoreError(403, "Only Claude Code's own config file can be restored, from its own backups."))
    const { req, res, next, sendBody } = createMockReqRes("POST", "/restore-config", { body: JSON.stringify({ path: "/etc/passwd" }) })

    await handler(req, res, next)
    sendBody()
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled())
    expect(res._getStatus()).toBe(403)

    expect(JSON.parse(res._getData()).error).toMatch(/own config file/)
  })

  it("needs a path", async () => {
    const { req, res, next, sendBody } = createMockReqRes("POST", "/restore-config", { body: "{}" })

    await handler(req, res, next)
    sendBody()
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled())
    expect(res._getStatus()).toBe(400)

    expect(mockRestore).not.toHaveBeenCalled()
  })
})
