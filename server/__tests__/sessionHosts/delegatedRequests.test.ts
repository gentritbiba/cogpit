// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
  const host = (id: string, name: string, remote: boolean) => ({
    id,
    name,
    remote,
    state: vi.fn(),
    address: vi.fn(),
  })
  return {
    local: host("local", "this machine", false),
    remote: host("dev_1", "agentbox", true),
    sessionsAskingUser: vi.fn(),
    deliverNotification: vi.fn(),
  }
})

vi.mock("../../lib/sessionOrigins", () => ({ sessionsAskingUser: mocks.sessionsAskingUser }))
vi.mock("../../lib/notificationDelivery", () => ({ deliverNotification: mocks.deliverNotification }))
vi.mock("../../sessionHosts/index", () => ({
  localHost: mocks.local,
  hostForOrigin: (origin: { deviceId?: string }) => (origin.deviceId ? mocks.remote : null),
  hostForSession: async () => mocks.local,
}))

import {
  __resetDelegatedRequestsForTest,
  listDelegatedRequests,
  markDelegatedRequestAnswered,
  pollDelegatedRequests,
  watchDelegatedRequestsOf,
} from "../../sessionHosts/delegatedRequests"

const question = { kind: "question", requestId: "q1", questions: [{ question: "Which DB?", multiSelect: false, options: ["pg", "sqlite"] }] }
const state = (sessionId: string, outcome: string, waiting: unknown[] = []) =>
  ({ sessionId, outcome, live: true, running: false, waiting })

beforeEach(() => {
  vi.clearAllMocks()
  __resetDelegatedRequestsForTest()
  mocks.sessionsAskingUser.mockResolvedValue([
    { sessionId: "r1", origin: { parentSessionId: "parent", deviceId: "dev_1", asksUser: true, createdAt: 1 } },
    { sessionId: "l1", origin: { parentSessionId: "other", asksUser: true, createdAt: 1 } },
  ])
  mocks.remote.address.mockResolvedValue({ dirName: "-home-app", fileName: "r1.jsonl" })
  mocks.local.address.mockImplementation(async (id: string) => (id === "parent" ? { dirName: "-work-app", fileName: "parent.jsonl" } : null))
})

describe("user request watcher", () => {
  it("lists what delegated sessions wait on and announces a remote question once", async () => {
    mocks.remote.state.mockResolvedValue(state("r1", "needs_input", [question]))
    mocks.local.state.mockResolvedValue(state("l1", "needs_input", [question]))

    await pollDelegatedRequests(1000)
    expect(listDelegatedRequests("parent")).toEqual([{
      sessionId: "r1",
      address: { dirName: "-home-app", fileName: "r1.jsonl" },
      parentSessionId: "parent",
      device: { id: "dev_1", name: "agentbox" },
      waiting: [question],
    }])
    expect(listDelegatedRequests("other")).toHaveLength(1)
    // The local session announces its own prompt; only the remote one notifies here.
    expect(mocks.deliverNotification).toHaveBeenCalledTimes(1)
    expect(mocks.deliverNotification).toHaveBeenCalledWith({
      title: "agentbox needs your answer",
      body: "Which DB?",
      nav: { sessionId: "parent", dirName: "-work-app" },
    }, "permission")

    await pollDelegatedRequests(4000)
    expect(mocks.deliverNotification).toHaveBeenCalledTimes(1)

    markDelegatedRequestAnswered("r1", "q1")
    expect(listDelegatedRequests("parent")).toEqual([])
  })

  it("drops answered requests and checks finished sessions rarely until they get more work", async () => {
    mocks.remote.state.mockResolvedValue(state("r1", "completed"))
    mocks.local.state.mockResolvedValue(state("l1", "completed"))
    await pollDelegatedRequests(1000)
    expect(listDelegatedRequests("parent")).toEqual([])

    await pollDelegatedRequests(5000)
    expect(mocks.remote.state).toHaveBeenCalledTimes(1)

    watchDelegatedRequestsOf("r1")
    await pollDelegatedRequests(6000)
    expect(mocks.remote.state).toHaveBeenCalledTimes(2)
  })
})
