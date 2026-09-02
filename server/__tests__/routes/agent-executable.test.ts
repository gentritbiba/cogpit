// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockDescribe = vi.hoisted(() => vi.fn())
vi.mock("../../agents/executables", () => ({ describeExecutableFor: mockDescribe }))

import type { Middleware, UseFn } from "../../http"
import { registerAgentExecutableRoutes } from "../../routes/agent-executable"
import { asIncomingMessage, asServerResponse } from "../http-fixtures"

function handler(): Middleware {
  let registered: Middleware | undefined
  const use: UseFn = (_path, middleware) => { registered = middleware }
  registerAgentExecutableRoutes(use)
  return registered!
}

function request(url: string, method = "GET") {
  const res = {
    statusCode: 200,
    body: "",
    setHeader: vi.fn(),
    end(chunk?: string) { this.body = chunk ?? "" },
  }
  const next = vi.fn()
  return { req: asIncomingMessage({ method, url }), res: asServerResponse(res), raw: res, next }
}

describe("GET /api/agent-executable/:kind", () => {
  beforeEach(() => mockDescribe.mockReset())

  it("returns the report for an agent with an executable choice", async () => {
    const report = { choice: { source: "auto" }, candidates: [], active: null }
    mockDescribe.mockReturnValue(Promise.resolve(report))
    const { req, res, raw, next } = request("/claude")

    await handler()(req, res, next)

    expect(mockDescribe).toHaveBeenCalledWith("claude")
    expect(next).not.toHaveBeenCalled()
    expect(JSON.parse(raw.body)).toEqual(report)
  })

  it("404s for an agent that has nothing to choose", async () => {
    mockDescribe.mockReturnValue(null)
    const { req, res, raw, next } = request("/codex")

    await handler()(req, res, next)

    expect(raw.statusCode).toBe(404)
    expect(next).not.toHaveBeenCalled()
  })

  it("passes unknown kinds and other methods along", async () => {
    const unknown = request("/vim")
    await handler()(unknown.req, unknown.res, unknown.next)
    expect(unknown.next).toHaveBeenCalled()

    const post = request("/claude", "POST")
    await handler()(post.req, post.res, post.next)
    expect(post.next).toHaveBeenCalled()
    expect(mockDescribe).not.toHaveBeenCalled()
  })
})
