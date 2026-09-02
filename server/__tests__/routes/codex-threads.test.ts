// @vitest-environment node
import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Middleware, UseFn } from "../../helpers"
import {
  registerCodexThreadRoutes,
  type CodexThreadClient,
} from "../../routes/codex-threads"

interface FakeResponse {
  statusCode: number
  setHeader: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
  json: () => unknown
}

function createClient(): CodexThreadClient {
  return {
    getGoal: vi.fn().mockResolvedValue({ goal: null }),
    setGoal: vi.fn().mockResolvedValue({
      goal: { threadId: "thread-1", objective: "Ship it" },
    }),
    clearGoal: vi.fn().mockResolvedValue({ cleared: true }),
    steerTurn: vi.fn().mockResolvedValue({ turnId: "turn-1" }),
    interruptTurn: vi.fn().mockResolvedValue({}),
  } as unknown as CodexThreadClient
}

function register(client: CodexThreadClient): Map<string, Middleware> {
  const handlers = new Map<string, Middleware>()
  const use: UseFn = (path, handler) => handlers.set(path, handler)
  registerCodexThreadRoutes(use, client)
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

describe("Codex thread routes", () => {
  let client: CodexThreadClient
  let handlers: Map<string, Middleware>

  beforeEach(() => {
    client = createClient()
    handlers = register(client)
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
