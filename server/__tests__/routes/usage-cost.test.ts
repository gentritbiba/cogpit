// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Middleware, UseFn } from "../../helpers"

const service = vi.hoisted(() => ({
  getModelRates: vi.fn(),
  makeWindow: vi.fn(),
  readSessionUsageCostSummary: vi.fn(),
  readUsageCostSummary: vi.fn(),
}))

vi.mock("../../lib/usageCost/service", () => service)

import { registerUsageCostRoutes } from "../../routes/usage-cost"

function sessionHandler(): Middleware {
  let handler: Middleware | undefined
  const use: UseFn = (path, candidate) => {
    if (path === "/api/usage-cost/session") handler = candidate
  }
  registerUsageCostRoutes(use)
  if (!handler) throw new Error("Session cost route was not registered")
  return handler
}

async function request(method: string, url: string): Promise<{
  status: number
  body: unknown
  next: ReturnType<typeof vi.fn>
}> {
  let status = 200
  let body = ""
  const next = vi.fn()
  const response = {
    get statusCode() { return status },
    set statusCode(value: number) { status = value },
    setHeader: vi.fn(),
    end: vi.fn((value?: string) => { body = value ?? "" }),
  }
  await sessionHandler()(
    { method, url } as never,
    response as never,
    next,
  )
  return { status, body: body ? JSON.parse(body) : null, next }
}

describe("session usage cost route", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns the selected transcript's detailed cost summary", async () => {
    const summary = { sessionId: "session-1", provider: "claude", costUsd: 1.25 }
    service.readSessionUsageCostSummary.mockResolvedValue(summary)

    const response = await request(
      "GET",
      "/?dirName=project&fileName=session-1.jsonl",
    )

    expect(response.status).toBe(200)
    expect(response.body).toEqual(summary)
    expect(service.readSessionUsageCostSummary).toHaveBeenCalledWith({
      dirName: "project",
      fileName: "session-1.jsonl",
    })
  })

  it("requires both transcript address fields", async () => {
    const response = await request("GET", "/?dirName=project")

    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: "dirName and fileName are required" })
    expect(service.readSessionUsageCostSummary).not.toHaveBeenCalled()
  })

  it("returns 404 when the transcript cannot be resolved", async () => {
    service.readSessionUsageCostSummary.mockResolvedValue(null)

    const response = await request(
      "GET",
      "/?dirName=project&fileName=missing.jsonl",
    )

    expect(response.status).toBe(404)
    expect(response.body).toEqual({ error: "Session transcript not found" })
  })

  it("passes non-GET requests and nested paths to the next handler", async () => {
    const post = await request("POST", "/?dirName=project&fileName=session.jsonl")
    const nested = await request("GET", "/nested?dirName=project&fileName=session.jsonl")

    expect(post.next).toHaveBeenCalledOnce()
    expect(nested.next).toHaveBeenCalledOnce()
    expect(service.readSessionUsageCostSummary).not.toHaveBeenCalled()
  })
})
