// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CrewLink } from "../../lib/sessionOrigins"

const mocks = vi.hoisted(() => ({
  active: [] as Array<{ sessionId: string }>,
  agentsRunning: vi.fn(async (_dirName: string, _sessionId: string) => true),
  archiveListeners: new Set<() => void>(),
  parents: new Map<string, CrewLink>(),
}))

vi.mock("../../agents/runtimes", () => ({
  allRuntimes: () => [{ kind: "agent-a", listActive: () => mocks.active }],
}))
vi.mock("../../agents/agentsRunning", () => ({ sessionAgentsRunning: mocks.agentsRunning }))
vi.mock("../../lib/sessionArchive", () => ({
  subscribeArchiveChanges: (listener: () => void) => {
    mocks.archiveListeners.add(listener)
    return () => mocks.archiveListeners.delete(listener)
  },
}))
vi.mock("../../lib/sessionOrigins", () => ({ sessionParents: async () => mocks.parents }))

import { markCatalogChanged, subscribeCatalog, type CatalogChange } from "../../sessionCatalog"
import {
  __resetVersionInputsForTest,
  followVersionInputs,
  noteListedAgents,
  noteNextArchiveCrossing,
  stopFollowingVersionInputs,
  type AwaitingRow,
} from "../../sessionList/versionInputs"

function awaiting(sessionId: string, row: Partial<AwaitingRow> = {}): AwaitingRow {
  return { sessionId, dirName: "proj", running: true, mtimeMs: Date.now(), ...row }
}

describe("list version inputs without file events", () => {
  let changes: CatalogChange[]
  let unsubscribe: () => void

  beforeEach(() => {
    vi.useFakeTimers()
    mocks.active = []
    mocks.parents = new Map()
    mocks.agentsRunning.mockReset().mockResolvedValue(true)
    changes = []
    unsubscribe = subscribeCatalog((change) => changes.push(change))
  })

  afterEach(() => {
    unsubscribe()
    __resetVersionInputsForTest()
    vi.useRealTimers()
  })

  /** Bumps since the last call; the inputs' own re-arming on a bump is not one. */
  const bumps = () => changes.splice(0).filter((change) => change.kind === "visible").length

  it("bumps when a runtime's turns change, checking only while one is in flight", async () => {
    mocks.active = [{ sessionId: "a" }]
    followVersionInputs()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(bumps()).toBe(0)

    mocks.active = []
    await vi.advanceTimersByTimeAsync(2_000)
    expect(bumps()).toBe(1)

    // Nothing in flight: the check stops until a transcript write re-arms it.
    mocks.active = [{ sessionId: "b" }]
    await vi.advanceTimersByTimeAsync(10_000)
    expect(bumps()).toBe(0)
    markCatalogChanged("touch")
    changes.splice(0)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(bumps()).toBe(1)
  })

  it("bumps once a listed session's agents stop, checking only while one is awaiting them", async () => {
    followVersionInputs()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mocks.agentsRunning).not.toHaveBeenCalled()

    noteListedAgents("list", [awaiting("s1")])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(mocks.agentsRunning).toHaveBeenCalledWith("proj", "s1")
    expect(bumps()).toBe(0)

    mocks.agentsRunning.mockResolvedValue(false)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(bumps()).toBe(1)
    mocks.agentsRunning.mockClear()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mocks.agentsRunning).not.toHaveBeenCalled()
  })

  it("forgets rows the next build of the same list no longer reports", async () => {
    followVersionInputs()
    noteListedAgents("list", [awaiting("s1"), awaiting("s2")])
    noteListedAgents("list", [awaiting("s2")])
    noteListedAgents("other list", [awaiting("s3")])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(mocks.agentsRunning.mock.calls.map(([, sessionId]) => sessionId).sort()).toEqual(["s2", "s3"])

    mocks.agentsRunning.mockClear()
    noteListedAgents("list", [])
    noteListedAgents("other list", [])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mocks.agentsRunning).not.toHaveBeenCalled()
  })

  it("leaves orphans alone and checks only the newest rows", async () => {
    followVersionInputs()
    const now = Date.now()
    mocks.agentsRunning.mockResolvedValue(false)
    noteListedAgents("list", [
      awaiting("orphan", { running: false, mtimeMs: now - 60 * 60_000 }),
      ...Array.from({ length: 40 }, (_, i) => awaiting(`s${i}`, { mtimeMs: now - i * 1000, running: false })),
    ])
    await vi.advanceTimersByTimeAsync(5_000)
    const checked = mocks.agentsRunning.mock.calls.map(([, sessionId]) => sessionId)
    expect(checked).toHaveLength(32)
    expect(checked).not.toContain("orphan")
    expect(checked).not.toContain("s39")
  })

  it("bumps on every archive write", () => {
    followVersionInputs()
    for (const listener of mocks.archiveListeners) listener()
    expect(bumps()).toBe(1)
    stopFollowingVersionInputs()
    expect(mocks.archiveListeners.size).toBe(0)
  })

  it("bumps when the next listed session crosses into idle archiving", async () => {
    followVersionInputs()
    noteNextArchiveCrossing(Date.now() + 60_000)
    noteNextArchiveCrossing(Date.now() + 120_000)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(bumps()).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(bumps()).toBe(1)
  })

  it("arms a crossing noted before anyone followed once someone does", async () => {
    noteNextArchiveCrossing(Date.now() + 1_000)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(bumps()).toBe(0)
    followVersionInputs()
    await vi.advanceTimersByTimeAsync(0)
    expect(bumps()).toBe(1)
  })

  it("bumps when a crew link changes", async () => {
    mocks.active = [{ sessionId: "lead" }]
    followVersionInputs()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(bumps()).toBe(0)

    mocks.parents = new Map([["child", { parentSessionId: "lead", createdAt: 1 }]])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(bumps()).toBe(1)
  })

  it("does nothing once nobody follows", async () => {
    mocks.active = [{ sessionId: "a" }]
    followVersionInputs()
    noteListedAgents("list", [awaiting("s1")])
    stopFollowingVersionInputs()
    mocks.active = []
    mocks.agentsRunning.mockResolvedValue(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(bumps()).toBe(0)
    expect(mocks.agentsRunning).not.toHaveBeenCalled()
  })
})
