// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
const origins = vi.hoisted(() => ({ sessionOrigin: vi.fn(async (): Promise<{ asksUser?: true } | null> => null) }))
vi.mock("../../lib/sessionOrigins", () => origins)
import { acknowledgeTask, attachTaskAuthority, cancelTask, closeTaskMonitor, refreshDelegatedTasks, type TaskAuthority } from "../../orchestration/delegatedTasks"
import { orchestrationStore } from "../../orchestration/storage"
import type { CommandReceipt } from "../../../shared/contracts/orchestration"
const acceptedReceipt: CommandReceipt = { id: "accepted", conversationId: "conversation", sessionId: "parent", bindingRevision: 1, state: "queued", intent: "queue", createdAt: 1, updatedAt: 1, position: 1 }
afterEach(closeTaskMonitor)
async function refreshUntil(predicate: () => boolean) { const until = Date.now() + 1000; while (!predicate()) { if (Date.now() > until) throw new Error("Delegation did not settle"); await refreshDelegatedTasks(); await new Promise((resolve) => setTimeout(resolve, 5)) } }
async function until(predicate: () => boolean) { const until = Date.now() + 1000; while (!predicate()) { if (Date.now() > until) throw new Error("Delegation did not settle"); await new Promise((resolve) => setTimeout(resolve, 5)) } }
describe("durable delegated results", () => {
  it("does not forward a result when child access is revoked while it is being read", async () => {
    const store = orchestrationStore()
    store.putTask("owner", { sourceId: "revoked-result", parentSessionId: "parent", childSessionId: "child" })
    let allowed = true
    let release!: (value: unknown) => void
    const result = vi.fn(() => new Promise((resolve) => { release = resolve }))
    const send = vi.fn(async (_id: string, _message: string) => ({ receipt: acceptedReceipt }))
    const host = { state: async () => ({ outcome: "completed" }), result, send, stop: async () => true }
    attachTaskAuthority("owner", "parent", { authorize: async (id) => id !== "child" || allowed, host: async () => host })
    await until(() => result.mock.calls.length === 1)
    allowed = false; release({ reply: "Private revoked child result" })
    await until(() => store.tasks("owner")[0]?.state === "running" && !send.mock.calls.length)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(send).not.toHaveBeenCalled()
    expect(store.tasks("owner")[0]?.result).toBeUndefined()
  })

  it("reloads acknowledgements after resolving the parent's host", async () => {
    const store = orchestrationStore()
    const task = store.putTask("owner", { sourceId: "ack-during-host", parentSessionId: "parent", childSessionId: "child" })
    store.updateTask("owner", task.id, { state: "completed", result: { reply: "Done" } })
    let release!: () => void
    const send = vi.fn(async (_id: string, _message: string) => ({ receipt: acceptedReceipt }))
    const host = { state: async () => ({ outcome: "completed" }), result: async () => null, send, stop: async () => true }
    const resolveHost = vi.fn(() => new Promise<typeof host>((resolve) => { release = () => resolve(host) }))
    attachTaskAuthority("owner", "parent", { authorize: async () => true, host: resolveHost })
    await until(() => resolveHost.mock.calls.length === 1)
    acknowledgeTask("owner", "parent", task.id); release()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(send).not.toHaveBeenCalled()
  })

  it("does not wake a task deleted while its parent host is being resolved", async () => {
    const store = orchestrationStore()
    const task = store.putTask("owner", { sourceId: "deleted-during-host", parentSessionId: "parent", childSessionId: "child" })
    store.updateTask("owner", task.id, { state: "completed", result: { reply: "Deleted child result" } })
    let release!: () => void
    const send = vi.fn(async (_id: string, _message: string) => ({ receipt: acceptedReceipt }))
    const host = { state: async () => ({ outcome: "completed" }), result: async () => null, send, stop: async () => true }
    const resolveHost = vi.fn(() => new Promise<typeof host>((resolve) => { release = () => resolve(host) }))
    attachTaskAuthority("owner", "parent", { authorize: async () => true, host: resolveHost })
    await until(() => resolveHost.mock.calls.length === 1)
    store.forgetSession("child"); release()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(send).not.toHaveBeenCalled()
    expect(store.tasks("owner")).toEqual([])
  })

  it("suppresses wakeups while a blocking caller owns the result and recovers an abandoned wait", async () => {
    const store = orchestrationStore()
    const task = store.putTask("owner", { sourceId: "blocking-task", parentSessionId: "parent", childSessionId: "child", deliveryDisposition: "blocking", blockingDeadline: Date.now() + 10000 })
    const send = vi.fn(async (_id: string, _message: string) => ({ receipt: acceptedReceipt }))
    const host = { state: async () => ({ outcome: "completed" }), result: async () => ({ reply: "Done" }), send, stop: async () => true }
    attachTaskAuthority("owner", "parent", { authorize: async () => true, host: async () => host } as TaskAuthority)
    await until(() => store.tasks("owner")[0]?.state === "completed")
    expect(send).not.toHaveBeenCalled()
    store.updateTask("owner", task.id, { blockingDeadline: Date.now() - 1 })
    await refreshDelegatedTasks()
    expect(send).toHaveBeenCalledOnce()
  })
  it("keeps a result after a parent timeout, reuses its wakeup ID after a lost response and acknowledges once", async () => {
    const store = orchestrationStore()
    const task = store.putTask("owner", { sourceId: "task-source-1", parentSessionId: "parent", childSessionId: "child" })
    const send = vi.fn().mockRejectedValueOnce(new Error("Lost response")).mockImplementation(async () => ({ receipt: { id: "accepted" } }))
    const host = { state: async () => ({ outcome: "completed" }), result: async () => ({ reply: "Task done" }), send, stop: async () => true }
    const authority = { authorize: async () => true, host: async () => host } as TaskAuthority
    attachTaskAuthority("owner", "parent", authority)
    await until(() => send.mock.calls.length === 1)
    expect(store.tasks("owner")[0]).toMatchObject({ state: "completed", result: { reply: "Task done" } })
    await refreshDelegatedTasks()
    expect(send.mock.calls[0][2]).toEqual(send.mock.calls[1][2])
    expect(store.tasks("owner")[0]?.wakeupCommandId).toBe(`task-result-${task.id}`)
    const acknowledged = acknowledgeTask("owner", "parent", task.id)
    expect(acknowledgeTask("owner", "parent", task.id)).toEqual(acknowledged)
    await refreshDelegatedTasks(); expect(send).toHaveBeenCalledTimes(2)
    expect(store.tasks("another-owner")).toEqual([])
  })
  it("does not read or wake a child after access is revoked and distinguishes cancellation", async () => {
    const store = orchestrationStore()
    const task = store.putTask("owner", { sourceId: "task-source-2", parentSessionId: "parent", childSessionId: "child" })
    const stop = vi.fn(async () => true)
    const host = vi.fn(async () => ({ state: async () => ({ outcome: "completed" }), result: async () => ({ reply: "private" }), send: vi.fn(), stop }))
    const denied = { authorize: async () => false, host } as TaskAuthority
    attachTaskAuthority("owner", "parent", denied)
    await refreshDelegatedTasks(); expect(host).not.toHaveBeenCalled()
    expect(() => acknowledgeTask("owner", "parent", task.id)).toThrow("not completed")
    await expect(cancelTask("owner", "parent", task.id, denied)).rejects.toMatchObject({ status: 404 })
    closeTaskMonitor()
    const cancelled = await cancelTask("owner", "parent", task.id, { ...denied, authorize: async () => true })
    expect(cancelled.state).toBe("cancelled"); expect(stop).toHaveBeenCalledOnce()
  })

  it("waits for a follow-up's own turn before reporting it, however the child looked before", async () => {
    const store = orchestrationStore()
    const task = store.putTask("owner", { sourceId: "follow-up-turn", parentSessionId: "follow-parent", childSessionId: "child", commandId: "follow-up" })
    let delivery: CommandReceipt["state"] = "queued"
    const receipt = vi.fn(async () => ({ ...acceptedReceipt, id: "follow-up", state: delivery }))
    const send = vi.fn(async (_id: string, _message: string) => ({ receipt: acceptedReceipt }))
    const host = { state: async () => ({ outcome: "completed" }), result: async () => ({ turn: { reply: "Follow-up done" } }), receipt, send, stop: async () => true }
    attachTaskAuthority("owner", "follow-parent", { authorize: async () => true, host: async () => host })
    await refreshUntil(() => receipt.mock.calls.length > 0)
    await refreshDelegatedTasks()
    expect(store.tasks("owner", "follow-parent")[0]?.state).toBe("running")
    expect(send).not.toHaveBeenCalled()
    delivery = "completed"
    await refreshUntil(() => send.mock.calls.length === 1)
    expect(store.tasks("owner", "follow-parent")[0]).toMatchObject({ state: "completed", result: { turn: { reply: "Follow-up done" } }, wakeupCommandId: `task-result-${task.id}` })
  })

  it("tells the parent once about each request its child is waiting on, unless the user answers it", async () => {
    const store = orchestrationStore()
    store.putTask("owner", { sourceId: "asks-question", parentSessionId: "asking-parent", childSessionId: "asking-child" })
    const question = { kind: "question" as const, requestId: "q-1", questions: [{ question: "Which colour?", multiSelect: false, options: ["Blue", "Red"] }] }
    const send = vi.fn(async (_id: string, _message: string) => ({ receipt: acceptedReceipt }))
    const state = vi.fn(async () => ({ outcome: "needs_input", waiting: [question] }))
    const host = { state, result: async () => null, send, stop: async () => true }
    attachTaskAuthority("owner", "asking-parent", { authorize: async () => true, host: async () => host })
    await refreshUntil(() => send.mock.calls.length === 1)
    await refreshDelegatedTasks()
    expect(send).toHaveBeenCalledOnce()
    const [parent, text, options] = send.mock.calls[0] as unknown as [string, string, { commandId: string }]
    expect(parent).toBe("asking-parent")
    expect(text).toMatch(/^Delegated task \S+ needs attention\. Child session: asking-child\./)
    expect(text).toContain("cogpit-session answer asking-child --request q-1")
    expect(options.commandId).toMatch(/^task-attention-/)
    expect(store.tasks("owner", "asking-parent")[0]).toMatchObject({ state: "running", notified: ["q-1"] })

    store.putTask("owner", { sourceId: "asks-user", parentSessionId: "user-parent", childSessionId: "user-child" })
    origins.sessionOrigin.mockResolvedValue({ asksUser: true })
    const userState = vi.fn(async () => ({ outcome: "needs_input", waiting: [question] }))
    const userSend = vi.fn(async () => ({ receipt: acceptedReceipt }))
    attachTaskAuthority("owner", "user-parent", { authorize: async () => true, host: async () => ({ ...host, state: userState, send: userSend }) })
    await refreshUntil(() => userState.mock.calls.length > 0)
    await refreshDelegatedTasks()
    expect(userSend).not.toHaveBeenCalled()
    origins.sessionOrigin.mockResolvedValue(null)
  })

  it("lets go of a parent once none of its tasks needs work, until it is armed again", async () => {
    const store = orchestrationStore()
    store.putTask("owner", { sourceId: "detach-first", parentSessionId: "idle-parent", childSessionId: "idle-child" })
    const send = vi.fn(async (_id: string, _message: string) => ({ receipt: acceptedReceipt }))
    const host = { state: async () => ({ outcome: "completed" }), result: async () => ({ reply: "Done" }), send, stop: async () => true }
    const authorize = vi.fn(async () => true)
    attachTaskAuthority("owner", "idle-parent", { authorize, host: async () => host })
    await refreshUntil(() => send.mock.calls.length === 1)
    await refreshDelegatedTasks()
    authorize.mockClear()
    await refreshDelegatedTasks()
    expect(authorize).not.toHaveBeenCalled()

    store.putTask("owner", { sourceId: "detach-second", parentSessionId: "idle-parent", childSessionId: "idle-child-2" })
    attachTaskAuthority("owner", "idle-parent", { authorize, host: async () => host })
    await until(() => send.mock.calls.length === 2)
    expect(send.mock.calls[1]![1]).toContain("Child session: idle-child-2")
  })

  it("remembers what the parent was told about a child across its tasks", async () => {
    const store = orchestrationStore()
    const earlier = store.putTask("owner", { sourceId: "told-earlier", parentSessionId: "told-parent", childSessionId: "told-child" })
    store.updateTask("owner", earlier.id, { state: "completed", acknowledgedAt: 1, notified: ["q-told"] })
    store.putTask("owner", { sourceId: "told-later", parentSessionId: "told-parent", childSessionId: "told-child", commandId: "later" })
    const question = { kind: "question" as const, requestId: "q-told", questions: [{ question: "Again?", multiSelect: false, options: ["Yes"] }] }
    const state = vi.fn(async () => ({ outcome: "needs_input", waiting: [question] }))
    const send = vi.fn(async (_id: string, _message: string) => ({ receipt: acceptedReceipt }))
    attachTaskAuthority("owner", "told-parent", { authorize: async () => true, host: async () => ({ state, result: async () => null, send, stop: async () => true }) })
    await refreshUntil(() => state.mock.calls.length > 1)
    expect(send).not.toHaveBeenCalled()
  })

  it("tells the parent when its follow-up is held, and drops a cancelled one silently", async () => {
    const store = orchestrationStore()
    store.putTask("owner", { sourceId: "held-follow-up", parentSessionId: "held-parent", childSessionId: "held-child", commandId: "held-message" })
    let delivery: CommandReceipt["state"] = "held"
    const send = vi.fn(async (_id: string, _message: string) => ({ receipt: acceptedReceipt }))
    const host = { state: async () => ({ outcome: "completed" }), result: async () => null, receipt: async () => ({ ...acceptedReceipt, id: "held-message", state: delivery, error: "Host restarted; resume this queue after reviewing it." }), send, stop: async () => true }
    attachTaskAuthority("owner", "held-parent", { authorize: async () => true, host: async () => host })
    await refreshUntil(() => send.mock.calls.length === 1)
    await refreshDelegatedTasks()
    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0]![1]).toContain("Your message held-message is held: Host restarted")
    expect(send.mock.calls[0]![1]).toContain("cogpit-session queue held-child")
    delivery = "cancelled"
    await refreshUntil(() => store.tasks("owner", "held-parent")[0]?.state === "cancelled")
    expect(send).toHaveBeenCalledOnce()
  })
})
