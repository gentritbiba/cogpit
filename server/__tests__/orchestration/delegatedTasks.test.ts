// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import { acknowledgeTask, attachTaskAuthority, cancelTask, closeTaskMonitor, refreshDelegatedTasks, type TaskAuthority } from "../../orchestration/delegatedTasks"
import { orchestrationStore } from "../../orchestration/storage"
import type { CommandReceipt } from "../../../shared/contracts/orchestration"
const acceptedReceipt: CommandReceipt = { id: "accepted", conversationId: "conversation", sessionId: "parent", bindingRevision: 1, state: "queued", intent: "queue", createdAt: 1, updatedAt: 1, position: 1 }
afterEach(closeTaskMonitor)
async function until(predicate: () => boolean) { const until = Date.now() + 1000; while (!predicate()) { if (Date.now() > until) throw new Error("Delegation did not settle"); await new Promise((resolve) => setTimeout(resolve, 5)) } }
describe("durable delegated results", () => {
  it("does not forward a result when child access is revoked while it is being read", async () => {
    const store = orchestrationStore()
    store.putTask("owner", { sourceId: "revoked-result", parentSessionId: "parent", childSessionId: "child" })
    let allowed = true
    let release!: (value: unknown) => void
    const result = vi.fn(() => new Promise((resolve) => { release = resolve }))
    const send = vi.fn(async () => ({ receipt: acceptedReceipt }))
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
    const send = vi.fn(async () => ({ receipt: acceptedReceipt }))
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
    const send = vi.fn(async () => ({ receipt: acceptedReceipt }))
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
    const send = vi.fn(async () => ({ receipt: acceptedReceipt }))
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
})
