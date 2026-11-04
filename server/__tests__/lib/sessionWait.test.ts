// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  findJsonlPath: vi.fn(),
  getSessionStatus: vi.fn(),
  listPendingInput: vi.fn(),
  activity: new Map<string, { live: boolean; running: boolean }>(),
  held: new Set<string>(),
  agentsRunning: vi.fn(),
}))

const runtime = {
  kind: "claude",
  descriptor: { capabilities: { activeNotifications: true } },
  activity: (id: string) => mocks.activity.get(id) ?? { live: false, running: false },
  hasSession: (id: string) => mocks.held.has(id),
}

vi.mock("../../sessionPaths", () => ({ findJsonlPath: mocks.findJsonlPath }))
vi.mock("../../helpers", () => ({ getSessionStatus: mocks.getSessionStatus }))
vi.mock("../../agents", () => ({
  storeForPath: (path: string | null) => (path ? { kind: "k", sessionAddress: async () => ({ dirName: "-work", fileName: "a.jsonl" }) } : null),
}))
vi.mock("../../agents/agentsRunning", () => ({ sessionAgentsRunning: mocks.agentsRunning }))
vi.mock("../../agents/runtimes", () => ({
  runtimeFor: () => runtime,
  runtimeForSession: (id: string) => (mocks.held.has(id) ? runtime : null),
}))
vi.mock("../../agents/pendingInput", () => ({ listPendingInput: mocks.listPendingInput }))

import { orchestrationStore } from "../../orchestration/storage"
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
  mocks.agentsRunning.mockReset().mockResolvedValue(false)
})

const written = (agoMs: number) => ({ filePath: "/t/a.jsonl", lastActivityMs: Date.now() - agoMs })

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

  it("reads an unmanaged session's progress from the tail while its transcript is being written", async () => {
    mocks.getSessionStatus.mockResolvedValue({ status: "thinking" })
    expect((await readSessionState("a", written(5_000))).outcome).toBe("running")
    expect(mocks.findJsonlPath).not.toHaveBeenCalled()
  })

  it("reads a mid-flight tail nothing holds and nothing writes as finished", async () => {
    mocks.getSessionStatus.mockResolvedValue({ status: "tool_use", toolName: "Bash" })
    expect((await readSessionState("a", written(2 * 24 * 60 * 60_000))).outcome).toBe("completed")
    // A transcript it cannot stat has not been written lately either.
    expect((await readSessionState("a")).outcome).toBe("completed")
  })

  it("keeps a session waiting on its agents running while it is held or its agents still write", async () => {
    mocks.getSessionStatus.mockResolvedValue({ status: "awaiting_agents" })
    mocks.activity.set("a", { live: true, running: false })
    expect((await readSessionState("a", written(60 * 60_000))).outcome).toBe("running")

    mocks.activity.clear()
    expect((await readSessionState("a", written(60 * 60_000))).outcome).toBe("completed")
    mocks.agentsRunning.mockResolvedValue(true)
    expect((await readSessionState("a", written(60 * 60_000))).outcome).toBe("running")
    expect(mocks.agentsRunning).toHaveBeenCalledWith("-work", "a")
  })

  it("keeps a session running while a message queued for it is about to start its next turn", async () => {
    mocks.activity.set("a", { live: true, running: false })
    const store = orchestrationStore()
    const conversation = store.ensureConversation({ hostId: "local", agent: "claude", instanceId: "default", sessionId: "a", nativeSessionId: "a" })
    store.admit("local", "notice-only", conversation.id, { message: "chat notice", onlyWhileRunning: true })
    expect((await readSessionState("a")).outcome).toBe("completed")
    store.admit("local", "follow-up", conversation.id, { message: "Now add a test" })
    expect((await readSessionState("a")).outcome).toBe("running")
    // A restart holds queued messages, and a held message blocks the queue.
    store.acquire("restarted-host")
    expect(store.command("local", "follow-up")?.receipt.state).toBe("held")
    expect((await readSessionState("a")).outcome).toBe("completed")
  })

  it("surfaces a recorded turn error until it is cleared", async () => {
    recordTurnError("a", "resume failed")
    expect(await readSessionState("a")).toMatchObject({ outcome: "error", error: "resume failed" })
    clearTurnError("a")
    expect((await readSessionState("a")).outcome).toBe("completed")
  })

  it("reports a turn the agent failed as an error, in plain words first", async () => {
    const failure = { reason: "not_signed_in", message: "Invalid API key · Fix external API key", httpStatus: 401 }
    mocks.getSessionStatus.mockResolvedValue({ status: "completed", terminalReason: "authentication_failed", failure })
    expect(await readSessionState("a", written(60_000))).toMatchObject({
      outcome: "error",
      error: "Claude Code isn't signed in. Invalid API key · Fix external API key",
      failure,
    })
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
