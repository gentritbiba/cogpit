// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  findJsonlPath: vi.fn(),
  getSessionStatus: vi.fn(),
  listPendingInput: vi.fn(),
  activity: new Map<string, { live: boolean; running: boolean }>(),
  held: new Set<string>(),
}))

const runtime = {
  activity: (id: string) => mocks.activity.get(id) ?? { live: false, running: false },
  hasSession: (id: string) => mocks.held.has(id),
}

vi.mock("../../sessionPaths", () => ({ findJsonlPath: mocks.findJsonlPath }))
vi.mock("../../helpers", () => ({ getSessionStatus: mocks.getSessionStatus }))
vi.mock("../../agents", () => ({ storeForPath: (path: string | null) => (path ? { kind: "k" } : null) }))
vi.mock("../../agents/runtimes", () => ({
  runtimeFor: () => runtime,
  runtimeForSession: (id: string) => (mocks.held.has(id) ? runtime : null),
}))
vi.mock("../../agents/pendingInput", () => ({ listPendingInput: mocks.listPendingInput }))

import {
  clearTurnError,
  parseWaitSeconds,
  readSessionState,
  recordTurnError,
  waitForSessions,
} from "../../lib/sessionWait"

beforeEach(() => {
  mocks.activity.clear()
  mocks.held.clear()
  mocks.findJsonlPath.mockReset().mockImplementation(async (id: string) => `/t/${id}.jsonl`)
  mocks.getSessionStatus.mockReset().mockResolvedValue({ status: "completed" })
  mocks.listPendingInput.mockReset().mockReturnValue([])
})

afterEach(() => {
  clearTurnError("a")
})

describe("readSessionState", () => {
  it("is not_found when neither a transcript nor a runtime knows the id", async () => {
    mocks.findJsonlPath.mockResolvedValue(null)
    expect(await readSessionState("a")).toEqual({
      sessionId: "a",
      outcome: "not_found",
      live: false,
      running: false,
      waiting: [],
    })
  })

  it("answers for a live session whose transcript is not on disk yet", async () => {
    mocks.findJsonlPath.mockResolvedValue(null)
    mocks.held.add("a")
    mocks.activity.set("a", { live: true, running: true })
    expect(await readSessionState("a")).toMatchObject({ outcome: "running", live: true })
    expect(mocks.getSessionStatus).not.toHaveBeenCalled()
  })

  it("trusts a managed session's running flag over a stale tail", async () => {
    mocks.activity.set("a", { live: true, running: false })
    mocks.getSessionStatus.mockResolvedValue({ status: "tool_use" })
    expect((await readSessionState("a")).outcome).toBe("completed")
  })

  it("reads an unmanaged session's progress from the tail", async () => {
    mocks.getSessionStatus.mockResolvedValue({ status: "thinking" })
    expect((await readSessionState("a")).outcome).toBe("running")
  })

  it("surfaces a recorded turn error until it is cleared", async () => {
    recordTurnError("a", "resume failed")
    expect(await readSessionState("a")).toMatchObject({ outcome: "error", error: "resume failed" })
    clearTurnError("a")
    expect((await readSessionState("a")).outcome).toBe("completed")
  })
})

describe("waitForSessions", () => {
  it("returns once every session has settled in all mode", async () => {
    mocks.activity.set("b", { live: true, running: true })
    setTimeout(() => mocks.activity.set("b", { live: true, running: false }), 30)

    const result = await waitForSessions(["a", "b"], { mode: "all", timeoutMs: 2000, pollMs: 10 })
    expect(result.timedOut).toBe(false)
    expect(result.sessions.map((s) => s.outcome)).toEqual(["completed", "completed"])
  })

  it("returns as soon as one settles in any mode", async () => {
    mocks.activity.set("b", { live: true, running: true })
    const result = await waitForSessions(["a", "b"], { mode: "any", timeoutMs: 2000, pollMs: 10 })
    expect(result.timedOut).toBe(false)
    expect(result.sessions.map((s) => s.outcome)).toEqual(["completed", "running"])
  })

  it("stops waiting on a session that needs input", async () => {
    mocks.activity.set("a", { live: true, running: true })
    mocks.listPendingInput.mockReturnValue([{ kind: "question", requestId: "q", questions: [] }])
    const result = await waitForSessions(["a"], { mode: "all", timeoutMs: 2000, pollMs: 10 })
    expect(result.sessions[0].outcome).toBe("needs_input")
  })

  it("times out, and gives up early when the caller aborts", async () => {
    mocks.activity.set("a", { live: true, running: true })
    expect((await waitForSessions(["a"], { mode: "all", timeoutMs: 20, pollMs: 5 })).timedOut).toBe(true)

    const controller = new AbortController()
    controller.abort()
    const started = Date.now()
    const aborted = await waitForSessions(["a"], { mode: "all", timeoutMs: 10_000, signal: controller.signal })
    expect(aborted.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe("parseWaitSeconds", () => {
  it("defaults, caps and rejects", () => {
    expect(parseWaitSeconds(undefined)).toBe(90)
    expect(parseWaitSeconds("5")).toBe(5)
    expect(parseWaitSeconds(99_999)).toBe(3600)
    expect(parseWaitSeconds("-1")).toBeNull()
    expect(parseWaitSeconds("soon")).toBeNull()
  })
})
