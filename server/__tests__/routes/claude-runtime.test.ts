// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import type { Middleware, UseFn } from "../../helpers"
import { registerClaudeRuntimeRoutes } from "../../routes/claude-runtime"

describe("Claude runtime route", () => {
  it("returns the SDK-backed capability and usage snapshot", async () => {
    let handler: Middleware | undefined
    const use: UseFn = (_path, nextHandler) => { handler = nextHandler }
    const getSnapshot = vi.fn().mockResolvedValue({
      available: true,
      account: { subscriptionType: "max" },
      usage: { rate_limits: { five_hour: { utilization: 20 } } },
      models: [{ value: "fable" }],
      agents: [{ name: "reviewer" }],
      fetchedAt: 123,
    })
    registerClaudeRuntimeRoutes(use, getSnapshot)

    let payload = ""
    const response = {
      statusCode: 0,
      setHeader: vi.fn(),
      end: vi.fn((value: string) => { payload = value }),
    }
    handler!(
      { method: "GET", url: "/" } as Parameters<Middleware>[0],
      response as unknown as Parameters<Middleware>[1],
      vi.fn(),
    )
    await vi.waitFor(() => expect(response.end).toHaveBeenCalled())

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(payload)).toMatchObject({
      available: true,
      account: { subscriptionType: "max" },
      models: [{ value: "fable" }],
      agents: [{ name: "reviewer" }],
    })
    expect(getSnapshot).toHaveBeenCalledWith(false)
  })
})
