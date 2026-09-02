// @vitest-environment node
import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Middleware, UseFn } from "../../helpers"

/**
 * `GET /api/<cli>/runtime` for every agent, from one registry-driven module.
 *
 * The three snapshots keep their own wire shapes — external clients read them,
 * and they genuinely report different things — so what is asserted here is that
 * each path reaches its own runtime and that failure looks the same everywhere.
 */

const { runtimes } = vi.hoisted(() => ({
  runtimes: {
    claude: { describeRuntime: vi.fn() },
    codex: { describeRuntime: vi.fn() },
    copilot: { describeRuntime: vi.fn() },
  } as Record<string, { describeRuntime: ReturnType<typeof vi.fn> }>,
}))

vi.mock("../../agents/runtimes", async () => {
  const { descriptorFor, AGENT_KINDS } = await vi.importActual<
    typeof import("../../../shared/session/agent-descriptors")
  >("../../../shared/session/agent-descriptors")
  return {
    allRuntimes: () => AGENT_KINDS.map((kind) => ({
      kind,
      descriptor: descriptorFor(kind),
      describeRuntime: runtimes[kind].describeRuntime,
    })),
  }
})

import { registerAgentRuntimeRoutes } from "../../routes/agent-runtime"

function register(): Map<string, Middleware> {
  const handlers = new Map<string, Middleware>()
  const use: UseFn = (path, handler) => handlers.set(path, handler)
  registerAgentRuntimeRoutes(use)
  return handlers
}

async function invoke(handler: Middleware, url = "/", method = "GET") {
  const req = new EventEmitter() as EventEmitter & { method: string; url: string }
  req.method = method
  req.url = url

  let payload = ""
  let statusCode = 200
  const res = {
    get statusCode() { return statusCode },
    set statusCode(value: number) { statusCode = value },
    setHeader: vi.fn(),
    end: vi.fn((value?: string) => { payload = value ?? "" }),
  }
  const next = vi.fn()
  handler(
    req as unknown as Parameters<Middleware>[0],
    res as unknown as Parameters<Middleware>[1],
    next,
  )
  await vi.waitFor(() => {
    expect(res.end.mock.calls.length + next.mock.calls.length).toBeGreaterThan(0)
  })
  return { statusCode: res.statusCode, json: () => JSON.parse(payload) as unknown, next }
}

beforeEach(() => {
  for (const runtime of Object.values(runtimes)) runtime.describeRuntime.mockReset()
})

describe("agent runtime routes", () => {
  it("registers one path per agent, named by its executable", () => {
    // Registration follows detection order, which is what the registry hands out.
    expect([...register().keys()].sort()).toEqual([
      "/api/claude/runtime",
      "/api/codex/runtime",
      "/api/copilot/runtime",
    ])
  })

  it.each([
    ["claude", "/api/claude/runtime", { available: true, account: null, models: [] }],
    ["codex", "/api/codex/runtime", { available: true, version: "0.144.1", errors: {} }],
    ["copilot", "/api/copilot/runtime", { available: true, quota: { entitlement: 100 } }],
  ])("returns the %s snapshot in its own wire shape", async (kind, path, snapshot) => {
    runtimes[kind].describeRuntime.mockResolvedValue(snapshot)

    const { statusCode, json } = await invoke(register().get(path)!)

    expect(statusCode).toBe(200)
    expect(json()).toEqual(snapshot)
    expect(runtimes[kind].describeRuntime).toHaveBeenCalledWith(false)
  })

  it("forwards an explicit refresh past the runtime's own cache", async () => {
    runtimes.claude.describeRuntime.mockResolvedValue({ available: true })
    await invoke(register().get("/api/claude/runtime")!, "/?refresh=1")
    expect(runtimes.claude.describeRuntime).toHaveBeenCalledWith(true)
  })

  it("reports a runtime that cannot describe itself as a 502", async () => {
    runtimes.claude.describeRuntime.mockRejectedValue(new Error("control channel timed out"))

    const { statusCode, json } = await invoke(register().get("/api/claude/runtime")!)

    expect(statusCode).toBe(502)
    expect(json()).toEqual({ available: false, error: "control channel timed out" })
  })

  it("passes through methods and nested paths it does not own", async () => {
    const handlers = register()
    expect((await invoke(handlers.get("/api/copilot/runtime")!, "/", "POST")).next)
      .toHaveBeenCalledOnce()
    expect((await invoke(handlers.get("/api/copilot/runtime")!, "/session-1")).next)
      .toHaveBeenCalledOnce()
  })
})
