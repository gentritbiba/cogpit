// @vitest-environment node
import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Middleware, UseFn } from "../../helpers"
import {
  registerCodexRuntimeRoutes,
  type CodexRuntimeClient,
} from "../../routes/codex-runtime"

interface FakeResponse {
  statusCode: number
  setHeader: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
  json: () => unknown
}

function createClient(): CodexRuntimeClient {
  return {
    start: vi.fn().mockResolvedValue({
      userAgent: "cogpit/0.144.1 (Mac OS; arm64) (cogpit; 0.6.7)",
      platformFamily: "unix",
      platformOs: "macos",
      codexHome: "/home/test/.codex",
    }),
    call: vi.fn().mockImplementation(async (method: string) => ({ method })),
    getGoal: vi.fn().mockResolvedValue({ goal: null }),
    setGoal: vi.fn().mockResolvedValue({
      goal: { threadId: "thread-1", objective: "Ship it" },
    }),
    clearGoal: vi.fn().mockResolvedValue({ cleared: true }),
    steerTurn: vi.fn().mockResolvedValue({ turnId: "turn-1" }),
    interruptTurn: vi.fn().mockResolvedValue({}),
  } as unknown as CodexRuntimeClient
}

function register(client: CodexRuntimeClient): Map<string, Middleware> {
  const handlers = new Map<string, Middleware>()
  const use: UseFn = (path, handler) => handlers.set(path, handler)
  registerCodexRuntimeRoutes(use, client)
  return handlers
}

async function invoke(
  handler: Middleware,
  options: { method: string; url?: string; body?: unknown },
): Promise<{ response: FakeResponse; next: ReturnType<typeof vi.fn> }> {
  const req = new EventEmitter() as EventEmitter & {
    method: string
    url: string
  }
  req.method = options.method
  req.url = options.url ?? "/"

  let payload = ""
  const response: FakeResponse = {
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn((value?: string) => {
      payload = value ?? ""
    }),
    json: () => JSON.parse(payload) as unknown,
  }
  const next = vi.fn()
  handler(
    req as unknown as Parameters<Middleware>[0],
    response as unknown as Parameters<Middleware>[1],
    next,
  )
  if (options.body !== undefined) {
    req.emit("data", JSON.stringify(options.body))
  }
  req.emit("end")
  await vi.waitFor(() => {
    expect(response.end.mock.calls.length + next.mock.calls.length).toBeGreaterThan(0)
  })
  return { response, next }
}

describe("Codex runtime routes", () => {
  let client: CodexRuntimeClient
  let handlers: Map<string, Middleware>

  beforeEach(() => {
    client = createClient()
    handlers = register(client)
  })

  it("returns initialized runtime capabilities and provider-native sections", async () => {
    const handler = handlers.get("/api/codex/runtime")!
    const { response } = await invoke(handler, { method: "GET" })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      available: true,
      version: "0.144.1",
      userAgent: "cogpit/0.144.1 (Mac OS; arm64) (cogpit; 0.6.7)",
      capabilities: {
        experimentalApi: false,
        platformFamily: "unix",
        platformOs: "macos",
        codexHome: "/home/test/.codex",
      },
      account: { method: "account/read" },
      usage: { method: "account/usage/read" },
      rateLimits: { method: "account/rateLimits/read" },
      experimentalFeatures: { method: "experimentalFeature/list" },
      permissionProfiles: { method: "permissionProfile/list" },
      errors: {},
    })
    expect(client.call).toHaveBeenCalledWith("account/read", {
      refreshToken: false,
    })
    expect(client.call).toHaveBeenCalledWith("account/usage/read")
    expect(client.call).toHaveBeenCalledWith("account/rateLimits/read")
    expect(client.call).toHaveBeenCalledWith("experimentalFeature/list", {})
    expect(client.call).toHaveBeenCalledWith("permissionProfile/list", {})
  })

  it("keeps successful runtime sections when another method is unavailable", async () => {
    vi.mocked(client.call).mockImplementation(async (method: string) => {
      if (method === "account/usage/read") throw new Error("not supported")
      return { method }
    })
    const handler = handlers.get("/api/codex/runtime")!
    const { response } = await invoke(handler, { method: "GET" })
    const body = response.json() as Record<string, unknown>

    expect(body.available).toBe(true)
    expect(body.usage).toBeNull()
    expect(body.account).toEqual({ method: "account/read" })
    expect(body.errors).toEqual({ usage: "not supported" })
  })

  it("reports an unavailable CLI as runtime state instead of an opaque 500", async () => {
    vi.mocked(client.start).mockRejectedValue(new Error("codex not found"))
    const handler = handlers.get("/api/codex/runtime")!
    const { response } = await invoke(handler, { method: "GET" })
    const body = response.json() as Record<string, unknown>

    expect(response.statusCode).toBe(200)
    expect(body.available).toBe(false)
    expect(body.capabilities).toBeNull()
    expect(body.errors).toEqual({ runtime: "codex not found" })
    expect(client.call).not.toHaveBeenCalled()
  })

  it("gets, sets, and clears persisted thread goals", async () => {
    const handler = handlers.get("/api/codex/goals")!

    const get = await invoke(handler, { method: "GET", url: "/thread-1" })
    expect(get.response.json()).toEqual({ goal: null })
    expect(client.getGoal).toHaveBeenCalledWith("thread-1")

    const post = await invoke(handler, {
      method: "POST",
      url: "/thread-1",
      body: { objective: "Ship it", status: "active", tokenBudget: 40_000 },
    })
    expect(post.response.statusCode).toBe(200)
    expect(client.setGoal).toHaveBeenCalledWith("thread-1", {
      objective: "Ship it",
      status: "active",
      tokenBudget: 40_000,
    })

    const remove = await invoke(handler, {
      method: "DELETE",
      url: "/thread-1",
    })
    expect(remove.response.json()).toEqual({ cleared: true })
    expect(client.clearGoal).toHaveBeenCalledWith("thread-1")
  })

  it("validates goal ids and payloads before calling app-server", async () => {
    const handler = handlers.get("/api/codex/goals")!
    const invalidId = await invoke(handler, {
      method: "GET",
      url: "/bad%2Fthread",
    })
    expect(invalidId.response.statusCode).toBe(400)
    expect(invalidId.response.json()).toMatchObject({
      code: "INVALID_THREAD_ID",
    })

    const invalidGoal = await invoke(handler, {
      method: "POST",
      url: "/thread-1",
      body: { objective: "" },
    })
    expect(invalidGoal.response.statusCode).toBe(400)
    expect(invalidGoal.response.json()).toMatchObject({ code: "INVALID_GOAL" })
    expect(client.setGoal).not.toHaveBeenCalled()
  })

  it("steers and interrupts the active native turn", async () => {
    const handler = handlers.get("/api/codex/threads")!
    const steer = await invoke(handler, {
      method: "POST",
      url: "/thread-1/steer",
      body: { input: "Focus on tests", expectedTurnId: "turn-1" },
    })
    expect(steer.response.json()).toEqual({ turnId: "turn-1" })
    expect(client.steerTurn).toHaveBeenCalledWith(
      "thread-1",
      "Focus on tests",
      "turn-1",
    )

    const interrupt = await invoke(handler, {
      method: "POST",
      url: "/thread-1/interrupt",
      body: {},
    })
    expect(interrupt.response.json()).toEqual({ success: true })
    expect(client.interruptTurn).toHaveBeenCalledWith("thread-1", undefined)
  })
})
