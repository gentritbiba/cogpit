// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PendingInput } from "../../../shared/contracts/pendingInput"

const DAY = 24 * 60 * 60_000

const mocks = vi.hoisted(() => {
  const runtime = { kind: "claude", descriptor: { capabilities: { activeNotifications: true } } }
  return {
    runtime,
    parents: new Map<string, { parentSessionId: string; createdAt: number; name?: string }>(),
    origins: new Map<string, { deviceId?: string }>(),
    listing: [] as Array<{ sessionId: string; dirName: string; fileName: string; filePath: string; mtimeMs: number; size: number }>,
    signals: new Map<string, { activity?: { live: boolean; running: boolean; agentsRunning: boolean }; waiting?: PendingInput[]; startsNext?: boolean; turnError?: string }>(),
    status: new Map<string, { status: string; failure?: unknown }>(),
    meta: new Map<string, Record<string, unknown>>(),
    held: new Set<string>(),
    tasks: [] as Array<{ id: string; parentSessionId: string; childSessionId: string; state: string; createdAt: number; updatedAt: number; acknowledgedAt?: number }>,
    getSessionMeta: vi.fn(),
    getSessionStatus: vi.fn(),
    getSessionPullRequests: vi.fn(async () => []),
    readSessionState: vi.fn(),
    deviceState: vi.fn(),
  }
})

vi.mock("../../lib/sessionOrigins", () => ({
  sessionParents: async () => mocks.parents,
  sessionOrigin: async (id: string) => mocks.origins.get(id) ?? null,
}))
vi.mock("../../agents", () => ({
  allTopLevelSessions: async () => mocks.listing,
  storeForPath: (path: string | null) => (path ? { kind: "claude", instanceId: "default", sessionAddress: async () => null } : null),
}))
vi.mock("../../agents/runtimes", () => ({
  runtimeFor: () => mocks.runtime,
  runtimeForSession: (id: string) => (mocks.held.has(id) ? mocks.runtime : null),
}))
vi.mock("../../agents/pendingInput", () => ({ listPendingInput: (id: string) => mocks.signals.get(id)?.waiting ?? [] }))
vi.mock("../../agents/agentsRunning", () => ({ sessionAgentsRunning: async () => false }))
vi.mock("../../helpers", () => ({ getSessionMeta: mocks.getSessionMeta, getSessionStatus: mocks.getSessionStatus }))
vi.mock("../../lib/sessionPrIndex", () => ({
  getSessionPullRequests: mocks.getSessionPullRequests,
  getScannedSessionPullRequests: () => [],
}))
vi.mock("../../lib/sessionArchive", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/sessionArchive")>(),
  readArchive: async () => ({ archived: new Map(), kept: new Set() }),
}))
vi.mock("../../sessionHosts", () => ({
  localHost: { id: "local", name: "this machine", address: async () => null },
  hostForOrigin: (origin: { deviceId?: string } | null) => (origin?.deviceId
    ? { id: origin.deviceId, name: "agentbox", remote: true, state: mocks.deviceState, address: async () => null }
    : null),
}))
vi.mock("../../orchestration/storage", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../orchestration/storage")>(),
  orchestrationStore: () => ({
    conversationsStartingNext: () => new Set<string>(),
    findConversation: () => null,
    taskStates: (_scope: string, by: { childSessionIds: string[] }) => mocks.tasks.filter((task) => by.childSessionIds.includes(task.childSessionId)),
  }),
}))
vi.mock("../../lib/sessionWait", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/sessionWait")>()
  return {
    ...actual,
    readSessionState: mocks.readSessionState,
    readSessionSignals: async (id: string, filePath: string | null) => {
      if (!filePath && !mocks.held.has(id)) return null
      const signals = mocks.signals.get(id) ?? {}
      return {
        runtime: mocks.runtime,
        activity: signals.activity ?? { live: false, running: false, agentsRunning: false },
        waiting: signals.waiting ?? [],
        startsNext: signals.startsNext ?? false,
        ...(signals.turnError !== undefined && { turnError: signals.turnError }),
      }
    },
  }
})

import { readCrewSnapshot, resetCrewSnapshotForTest } from "../../lib/crewSnapshot"
import { createMockReqRes } from "../http-fixtures"

const req = () => createMockReqRes("GET", "/").req
const read = (sessionId: string, options: { brief?: boolean; localOnly?: boolean } = {}) =>
  readCrewSnapshot(req(), sessionId, { brief: options.brief ?? false, localOnly: options.localOnly ?? false })
const member = async (id: string, root = "lead") => (await read(root))!.members.find((entry) => entry.sessionId === id)

function list(sessionId: string, mtimeMs = Date.now() - 10 * 60_000, size = 100) {
  const entry = { sessionId, dirName: "-work", fileName: `${sessionId}.jsonl`, filePath: `/work/${sessionId}.jsonl`, mtimeMs, size }
  mocks.listing = [...mocks.listing.filter((known) => known.sessionId !== sessionId), entry]
  return entry
}

const question: PendingInput = { kind: "question", requestId: "q-1", questions: [{ question: "Which?", multiSelect: false, options: ["A"] }] }

beforeEach(() => {
  resetCrewSnapshotForTest()
  vi.clearAllMocks()
  mocks.parents = new Map([
    ["done", { parentSessionId: "lead", createdAt: 10, name: "done-lane" }],
    ["busy", { parentSessionId: "lead", createdAt: 20 }],
  ])
  mocks.origins.clear()
  mocks.signals.clear()
  mocks.status.clear()
  mocks.meta.clear()
  mocks.held.clear()
  mocks.tasks = []
  mocks.listing = []
  for (const id of ["lead", "done", "busy"]) list(id)
  mocks.getSessionMeta.mockImplementation(async (filePath: string) => {
    const id = filePath.slice("/work/".length, -".jsonl".length)
    return { firstUserMessage: `Prompt for ${id}`, turnCount: 2, lastTimestamp: undefined, ...mocks.meta.get(id) }
  })
  mocks.getSessionStatus.mockImplementation(async (filePath: string) => {
    const id = filePath.slice("/work/".length, -".jsonl".length)
    return mocks.status.get(id) ?? { status: "completed" }
  })
})

describe("readCrewSnapshot", () => {
  it("reads a settled member once, until something it changes by moves", async () => {
    expect(await member("done")).toMatchObject({ outcome: "completed", firstUserMessage: "Prompt for done", name: "done-lane", address: { dirName: "-work", fileName: "done.jsonl" } })
    const reads = mocks.getSessionPullRequests.mock.calls.length
    await read("lead")
    expect(mocks.getSessionPullRequests.mock.calls.length).toBe(reads)

    mocks.meta.set("done", { firstUserMessage: "Edited" })
    list("done", Date.now(), 200)
    expect(await member("done")).toMatchObject({ firstUserMessage: "Edited" })
  })

  it("shows a working member finishing by the clock, with no write to its transcript", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      vi.setSystemTime(1_000_000_000_000)
      list("busy", Date.now() - 1_000)
      mocks.status.set("busy", { status: "tool_use" })
      expect((await member("busy"))?.outcome).toBe("running")
      vi.setSystemTime(Date.now() + 5 * 60_000)
      expect((await member("busy"))?.outcome).toBe("completed")
    } finally { vi.useRealTimers() }
  })

  it("shows a request appearing and being answered on a settled member", async () => {
    expect((await member("done"))?.outcome).toBe("completed")
    mocks.signals.set("done", { waiting: [question] })
    expect(await member("done")).toMatchObject({ outcome: "needs_input", waiting: [{ requestId: "q-1" }] })
    mocks.signals.delete("done")
    expect(await member("done")).toMatchObject({ outcome: "completed", waiting: [] })
  })

  it("shows a turn starting, a queued message and a turn error without a transcript write", async () => {
    expect((await member("done"))?.outcome).toBe("completed")
    mocks.signals.set("done", { activity: { live: true, running: true, agentsRunning: false } })
    expect((await member("done"))?.outcome).toBe("running")
    mocks.signals.set("done", { startsNext: true })
    expect((await member("done"))?.outcome).toBe("running")
    mocks.signals.set("done", { turnError: "Resume failed" })
    expect(await member("done")).toMatchObject({ outcome: "error", error: "Resume failed" })
    mocks.signals.delete("done")
    expect((await member("done"))?.outcome).toBe("completed")
  })

  it("shows a member's task being acknowledged", async () => {
    mocks.tasks = [{ id: "t-1", parentSessionId: "lead", childSessionId: "done", state: "completed", createdAt: 1, updatedAt: 2 }]
    expect((await member("done"))?.result).toEqual({ taskId: "t-1", state: "completed", acknowledged: false })
    mocks.tasks = [{ ...mocks.tasks[0]!, acknowledgedAt: 3, updatedAt: 3 }]
    expect((await member("done"))?.result).toEqual({ taskId: "t-1", state: "completed", acknowledged: true })
  })

  it("lists members as the session list does: archived ones out, held ones in, without searching devices", async () => {
    mocks.parents.set("old", { parentSessionId: "lead", createdAt: 30 })
    mocks.parents.set("starting", { parentSessionId: "lead", createdAt: 40 })
    mocks.parents.set("moved", { parentSessionId: "lead", createdAt: 50 })
    list("old", Date.now() - 30 * DAY)
    mocks.held.add("starting")
    mocks.readSessionState.mockImplementation(async (id: string) => ({ sessionId: id, outcome: "running", live: true, running: true, waiting: [] }))
    const crew = await read("lead")
    expect(crew?.members.map((entry) => entry.sessionId)).toEqual(["lead", "done", "busy", "starting"])
    expect(crew?.members.at(-1)).toMatchObject({ outcome: "running", address: null, device: null })
  })

  it("asks a member's device at most every few seconds", async () => {
    mocks.parents.set("remote", { parentSessionId: "lead", createdAt: 60 })
    mocks.origins.set("remote", { deviceId: "dev_1" })
    mocks.deviceState.mockResolvedValue({ sessionId: "remote", outcome: "running", live: true, running: true, waiting: [] })
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      expect(await member("remote")).toMatchObject({ outcome: "running", device: { id: "dev_1", name: "agentbox" } })
      await read("lead")
      expect(mocks.deviceState).toHaveBeenCalledTimes(1)
      mocks.deviceState.mockResolvedValue({ sessionId: "remote", outcome: "completed", live: false, running: false, waiting: [] })
      vi.setSystemTime(Date.now() + 3_000)
      expect((await member("remote"))?.outcome).toBe("completed")
      expect(mocks.deviceState).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
    // A device asking for itself has no transcript or runtime for it here.
    expect((await read("lead", { localOnly: true }))?.members.map((entry) => entry.sessionId)).not.toContain("remote")
  })

  it("clips first prompts to a one-paragraph preview only when asked for a brief crew", async () => {
    const long = `Line one\n\n   ${"word ".repeat(200)}`
    mocks.meta.set("done", { firstUserMessage: long })
    const brief = (await read("lead", { brief: true }))!.members.find((entry) => entry.sessionId === "done")!.firstUserMessage!
    expect(brief.length).toBe(400)
    expect(brief.startsWith("Line one word word")).toBe(true)
    expect(brief.endsWith("…")).toBe(true)
    expect((await member("done"))?.firstUserMessage).toBe(long)
  })
})
