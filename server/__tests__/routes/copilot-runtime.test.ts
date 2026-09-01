// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Middleware, UseFn } from "../../helpers"
import {
  registerCopilotRuntimeRoutes,
  type CopilotRuntimeClient,
} from "../../routes/copilot-runtime"

function createClient(): CopilotRuntimeClient {
  return {
    getAccountQuota: vi.fn().mockResolvedValue({
      quotaSnapshots: {
        chat: {
          entitlementRequests: 200,
          usedRequests: 11,
          remainingPercentage: 94.5,
        },
      },
    }),
  }
}

function register(client: CopilotRuntimeClient): Middleware {
  let handler: Middleware | undefined
  const use: UseFn = (_path, route) => { handler = route }
  registerCopilotRuntimeRoutes(use, client)
  if (!handler) throw new Error("Copilot runtime route was not registered")
  return handler
}

async function invoke(
  handler: Middleware,
  method = "GET",
  url = "/",
): Promise<{
  statusCode: number
  json: Record<string, unknown>
  next: ReturnType<typeof vi.fn>
}> {
  let statusCode = 200
  let payload = ""
  const response = {
    get statusCode() { return statusCode },
    set statusCode(value: number) { statusCode = value },
    setHeader: vi.fn(),
    end: vi.fn((value?: string) => { payload = value ?? "" }),
  }
  const next = vi.fn()
  handler(
    { method, url } as Parameters<Middleware>[0],
    response as unknown as Parameters<Middleware>[1],
    next,
  )
  await vi.waitFor(() => {
    expect(response.end.mock.calls.length + next.mock.calls.length).toBeGreaterThan(0)
  })
  return {
    statusCode,
    json: payload ? JSON.parse(payload) as Record<string, unknown> : {},
    next,
  }
}

describe("Copilot runtime route", () => {
  let client: CopilotRuntimeClient
  let handler: Middleware

  beforeEach(() => {
    client = createClient()
    handler = register(client)
  })

  it("returns only account quota", async () => {
    const response = await invoke(handler)

    expect(response.statusCode).toBe(200)
    expect(response.json).toEqual({
      available: true,
      quota: {
        quotaSnapshots: {
          chat: {
            entitlementRequests: 200,
            usedRequests: 11,
            remainingPercentage: 94.5,
          },
        },
      },
      errors: {},
    })
    expect(client.getAccountQuota).toHaveBeenCalledOnce()
  })

  it("does not expose session metrics when a session id is supplied", async () => {
    const response = await invoke(handler, "GET", "/?sessionId=session-1")

    expect(response.json).not.toHaveProperty("usage")
    expect(response.json).toMatchObject({ available: true, errors: {} })
  })

  it("reports an unavailable CLI as runtime state", async () => {
    vi.mocked(client.getAccountQuota).mockRejectedValue(new Error("copilot not found"))

    const response = await invoke(handler)

    expect(response.statusCode).toBe(200)
    expect(response.json).toEqual({
      available: false,
      quota: null,
      errors: { runtime: "copilot not found" },
    })
  })

  it("passes through methods and nested paths it does not own", async () => {
    const methodResponse = await invoke(handler, "POST")
    const pathResponse = await invoke(handler, "GET", "/nested")

    expect(methodResponse.next).toHaveBeenCalledOnce()
    expect(pathResponse.next).toHaveBeenCalledOnce()
    expect(client.getAccountQuota).not.toHaveBeenCalled()
  })
})
