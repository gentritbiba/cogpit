// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CrewLink } from "../../lib/sessionOrigins"

const mocks = vi.hoisted(() => ({
  active: [] as Array<{ sessionId: string }>,
  agentsRunning: vi.fn(async () => true),
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
} from "../../sessionList/versionInputs"

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

    noteListedAgents("s1", { dirName: "proj", running: true })
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

  it("forgets a row that no longer awaits agents", async () => {
    followVersionInputs()
    noteListedAgents("s1", { dirName: "proj", running: true })
    noteListedAgents("s1", null)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mocks.agentsRunning).not.toHaveBeenCalled()
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
    noteListedAgents("s1", { dirName: "proj", running: true })
    stopFollowingVersionInputs()
    mocks.active = []
    mocks.agentsRunning.mockResolvedValue(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(bumps()).toBe(0)
    expect(mocks.agentsRunning).not.toHaveBeenCalled()
  })
})
