import { beforeEach, describe, expect, it, vi } from "vitest"
import type { CommandReceipt } from "../../../shared/contracts/orchestration"
import type { ConversationState } from "../conversationState"

const owner = vi.hoisted(() => ({ state: {} as ConversationState, listeners: new Set<() => void>() }))
vi.mock("../conversationState", () => ({ conversationStateFor: () => ({ snapshot: () => owner.state, subscribe: (listener: () => void) => { owner.listeners.add(listener); return () => owner.listeners.delete(listener) } }) }))
import { fetchWithModelFallback } from "../agents/modelFallback"

const receipt: CommandReceipt = { id: "accepted-command", conversationId: "conversation", sessionId: "native", bindingRevision: 1, state: "queued", intent: "queue", createdAt: 1, updatedAt: 1, position: 1 }
const options = { model: "unavailable", agentKind: "codex", errorFallback: "Failed" }
function update(patch: Partial<CommandReceipt>) { owner.state = { ...owner.state, commands: [{ ...receipt, ...patch }] }; for (const listener of owner.listeners) listener() }
beforeEach(() => {
  owner.listeners.clear()
  owner.state = { conversation: { id: "conversation", revision: 1, binding: { hostId: "local", agent: "codex", instanceId: "default", sessionId: "native" }, createdAt: 1, updatedAt: 1 }, commands: [receipt], cursor: 1, freshness: "current" }
})
describe("accepted command model fallback", () => {
  it("returns the accepted receipt so the timeline can show it from the queue", async () => {
    const accepted = await fetchWithModelFallback(async () => new Response(JSON.stringify({ receipt }), { status: 202 }), { ...options, model: undefined, agentKind: "claude" })
    expect(accepted.receipt).toEqual(receipt)
    expect((await fetchWithModelFallback(async () => new Response("{}", { status: 200 }), { ...options, model: undefined, agentKind: "claude" })).receipt).toBeNull()
  })
  it("observes a definitive queued rejection and sends one replacement without holding the composer", async () => {
    const send = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ receipt }), { status: 202 })).mockResolvedValueOnce(new Response("{}", { status: 202 }))
    const onModelRejected = vi.fn()
    const accepted = await fetchWithModelFallback(send, { ...options, onModelRejected })
    expect(accepted.res.status).toBe(202)
    expect(send).toHaveBeenCalledTimes(1)
    update({ state: "failed", errorCode: "MODEL_REJECTED" })
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    update({ state: "failed", errorCode: "MODEL_REJECTED" })
    expect(send).toHaveBeenLastCalledWith(undefined)
    expect(onModelRejected).toHaveBeenCalledExactlyOnceWith("unavailable")
    expect(owner.listeners.size).toBe(0)
  })
  it.each([{ state: "unknown" as const }, { state: "failed" as const }, { state: "failed" as const, errorCode: "MODEL_REJECTED", delivery: "started" as const }])("does not replay ambiguous or already delivered commands: %j", async (patch) => {
    const send = vi.fn(async () => new Response(JSON.stringify({ receipt }), { status: 202 }))
    await fetchWithModelFallback(send, options)
    update(patch)
    expect(send).toHaveBeenCalledOnce()
    expect(owner.listeners.size).toBe(0)
  })
  it("cancels observation when the session changes", async () => {
    const controller = new AbortController()
    const send = vi.fn(async () => new Response(JSON.stringify({ receipt }), { status: 202 }))
    await fetchWithModelFallback(send, { ...options, signal: controller.signal })
    controller.abort()
    update({ state: "failed", errorCode: "MODEL_REJECTED" })
    expect(send).toHaveBeenCalledOnce()
    expect(owner.listeners.size).toBe(0)
  })
})
