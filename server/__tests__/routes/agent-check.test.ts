// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockCheckAgents = vi.hoisted(() => vi.fn())
vi.mock("../../agents/agentCheck", () => ({ checkAgents: mockCheckAgents }))

import { registerAgentCheckRoutes } from "../../routes/agent-check"
import { collectRoutes, createMockReqRes, getRouteHandler } from "../http-fixtures"

const handler = getRouteHandler(collectRoutes(registerAgentCheckRoutes), "/api/agent-check")

describe("GET /api/agent-check", () => {
  beforeEach(() => {
    mockCheckAgents.mockReset()
  })

  it("answers every agent's check, never cached", async () => {
    const agents = [{ kind: "codex", binary: null }]
    mockCheckAgents.mockResolvedValueOnce(agents)
    const { req, res, next } = createMockReqRes("GET", "/")

    await handler(req, res, next)

    expect(res._getStatus()).toBe(200)
    expect(res._getHeaders()["Cache-Control"]).toBe("no-store")
    const body = JSON.parse(res._getData())
    expect(body.agents).toEqual(agents)
    expect(Number.isNaN(Date.parse(body.checkedAt))).toBe(false)
  })

  it("leaves other methods and sub-paths alone", async () => {
    for (const [method, url] of [["POST", "/"], ["GET", "/claude"]] as const) {
      const { req, res, next } = createMockReqRes(method, url)
      await handler(req, res, next)
      expect(next).toHaveBeenCalled()
    }
    expect(mockCheckAgents).not.toHaveBeenCalled()
  })
})
