// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import type { JsonValue, PluginRequest } from "@cogpit/plugin-contracts"
import { createRuntimePanelActivation, type RuntimePanelActivation, type RuntimePanelClient } from "../runtimePanelActivation"

const request: PluginRequest = { protocol: 1, type: "request", id: "r1", method: "storage.get", params: { key: "setting" } }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const running = new Set<RuntimePanelActivation>()
function setup(overrides: Partial<RuntimePanelClient> = {}, appendDraft?: (text: string) => void) {
  const client = {
    lease: vi.fn(async () => ({ id: "lease-1", expiresAt: Date.now() + 30_000 })),
    payload: vi.fn(async () => new ArrayBuffer(2)),
    renewLease: vi.fn(async () => ({ id: "lease-1", expiresAt: Date.now() + 30_000 })),
    revokeLease: vi.fn(async () => {}), call: vi.fn(async () => null), ...overrides,
  }
  const onLoaded = vi.fn(), onError = vi.fn()
  const activation = createRuntimePanelActivation({ client, pluginId: "example.sample", digest: "a".repeat(64), projectId: "p_project",
    contextEpoch: "epoch-1", active: true, onLoaded, onError, appendDraft })
  running.add(activation)
  return { client, onLoaded, onError, activation }
}
async function settle() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
afterEach(() => { for (const value of running) value.dispose(); running.clear(); vi.useRealTimers() })

describe("runtime panel activation", () => {
  it("cancels session actions without discarding in-flight workspace data on a session switch", async () => {
    const pending = deferred<JsonValue>(), append = vi.fn()
    const value = setup({ call: () => pending.promise }, append); await settle()
    const draft = value.activation.execute({ protocol: 1, type: "request", id: "draft", method: "composer.append", params: { text: "Old session" } }, new AbortController().signal)
    const data = value.activation.execute(request, new AbortController().signal)
    value.activation.resetSession()
    pending.resolve(null)
    await expect(draft).rejects.toThrow()
    await expect(data).resolves.toBeNull()
    expect(append).not.toHaveBeenCalled()
    expect(value.client.revokeLease).not.toHaveBeenCalled()
    await expect(value.activation.execute({ protocol: 1, type: "request", id: "new-draft", method: "composer.append", params: { text: "New session" } }, new AbortController().signal)).resolves.toBeNull()
    expect(append).toHaveBeenCalledExactlyOnceWith("New session")
  })
  it("appends a draft only after host authorization and limits repeated appends", async () => {
    const pending = deferred<JsonValue>(), append = vi.fn()
    const value = setup({ call: () => pending.promise }, append); await settle()
    const message: PluginRequest = { protocol: 1, type: "request", id: "draft", method: "composer.append", params: { text: "Review this task" } }
    const inflight = value.activation.execute(message, new AbortController().signal)
    expect(append).not.toHaveBeenCalled()
    pending.resolve(null)
    await expect(inflight).resolves.toBeNull()
    expect(append).toHaveBeenCalledExactlyOnceWith("Review this task")
    await expect(value.activation.execute(message, new AbortController().signal)).rejects.toMatchObject({ code: "RATE_LIMITED" })
    expect(append).toHaveBeenCalledOnce()
  })
  it("does not append after authorization fails or the panel becomes hidden", async () => {
    const message: PluginRequest = { protocol: 1, type: "request", id: "draft", method: "composer.append", params: { text: "Review" } }
    const append = vi.fn(), pending = deferred<JsonValue>()
    const denied = setup({ call: async () => { throw new Error("Permission revoked") } }, append); await settle()
    await expect(denied.activation.execute(message, new AbortController().signal)).rejects.toThrow("Permission revoked")
    const value = setup({ call: () => pending.promise }, append); await settle()
    const inflight = value.activation.execute(message, new AbortController().signal)
    value.activation.setActive(false); pending.resolve(null)
    await expect(inflight).rejects.toThrow()
    expect(append).not.toHaveBeenCalled()
  })
  it("refuses draft actions when the workspace has no permitted composer", async () => {
    const value = setup(); await settle()
    await expect(value.activation.execute({ protocol: 1, type: "request", id: "draft", method: "composer.append", params: { text: "Review" } }, new AbortController().signal)).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" })
    expect(value.client.call).not.toHaveBeenCalled()
  })
  it("loads the selected digest under a private lease and renews within ten seconds", async () => {
    vi.useFakeTimers()
    const value = setup(); await settle()
    expect(value.client.lease).toHaveBeenCalledWith("example.sample", "p_project", "epoch-1", expect.any(AbortSignal), undefined)
    expect(value.client.payload).toHaveBeenCalledWith("a".repeat(64), expect.any(AbortSignal))
    expect(value.onLoaded).toHaveBeenCalledWith(expect.any(ArrayBuffer), "lease-1")
    await vi.advanceTimersByTimeAsync(8000)
    expect(value.client.renewLease).toHaveBeenCalledOnce()
    value.activation.dispose()
    await vi.advanceTimersByTimeAsync(40_000)
    expect(value.client.renewLease).toHaveBeenCalledOnce()
    expect(value.client.revokeLease).toHaveBeenCalledExactlyOnceWith("lease-1")
  })
  it("aborts loading and revokes a lease which arrives after unmount", async () => {
    const lease = deferred<{ id: string; expiresAt: number }>(), bytes = deferred<ArrayBuffer>()
    const acquire = vi.fn((_id: string, _project: string | null, _epoch: string, _signal: AbortSignal) => lease.promise)
    const value = setup({ lease: acquire, payload: () => bytes.promise })
    value.activation.dispose()
    expect(acquire.mock.calls[0][3].aborted).toBe(true)
    lease.resolve({ id: "late-lease", expiresAt: Date.now() + 30_000 }); bytes.resolve(new ArrayBuffer(2)); await settle()
    expect(value.client.revokeLease).toHaveBeenCalledExactlyOnceWith("late-lease")
    expect(value.onLoaded).not.toHaveBeenCalled()
    expect(value.onError).not.toHaveBeenCalled()
  })
  it("revokes a granted lease when payload loading fails", async () => {
    const value = setup({ payload: async () => { throw new Error("private host response") } }); await settle()
    expect(value.client.revokeLease).toHaveBeenCalledExactlyOnceWith("lease-1")
    expect(value.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "Plugin panel could not be loaded" }))
  })
  it("aborts hidden-panel work, rejects new calls, and allows calls after resuming", async () => {
    const pending = deferred<JsonValue>()
    const call = vi.fn((_id: string, _request: PluginRequest, _signal: AbortSignal) => pending.promise)
    const value = setup({ call }); await settle()
    const inflight = value.activation.execute(request, new AbortController().signal)
    value.activation.setActive(false)
    expect(call.mock.calls[0][2].aborted).toBe(true)
    await expect(value.activation.execute(request, new AbortController().signal)).rejects.toThrow("hidden")
    pending.resolve("late")
    await expect(inflight).rejects.toThrow()
    value.activation.setActive(true)
    await expect(value.activation.execute(request, new AbortController().signal)).resolves.toBe("late")
  })
  it("revokes on frame failure and ignores late provider results", async () => {
    const pending = deferred<JsonValue>()
    const value = setup({ call: () => pending.promise }); await settle()
    const inflight = value.activation.execute(request, new AbortController().signal)
    value.activation.fail(new Error("Plugin frame navigated")); pending.resolve("late")
    await expect(inflight).rejects.toThrow()
    expect(value.client.revokeLease).toHaveBeenCalledExactlyOnceWith("lease-1")
    expect(value.onError).toHaveBeenCalledOnce()
    value.activation.fail(new Error("again")); expect(value.onError).toHaveBeenCalledOnce()
  })
  it("revokes when renewal fails or a stalled renewal reaches local expiry", async () => {
    vi.useFakeTimers()
    const rejected = setup({ renewLease: async () => { throw new Error("offline") } }); await settle()
    await vi.advanceTimersByTimeAsync(8000)
    expect(rejected.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "Plugin activation could not be renewed" }))
    const stalled = setup({ renewLease: async () => new Promise(() => {}) }); await settle()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(stalled.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "Plugin activation expired" }))
    await expect(stalled.activation.execute(request, new AbortController().signal)).rejects.toThrow()
  })
})


describe("trusted plugin session navigation", () => {
  it("keeps addresses out of the frame result and navigates only after both authorizations", async () => {
    const openSession = vi.fn(), resolved = deferred<{ dirName: string; fileName: string }>()
    const client = { lease: vi.fn(async () => ({ id: "lease-1", expiresAt: Date.now() + 30000 })), payload: vi.fn(async () => new ArrayBuffer(2)), renewLease: vi.fn(), revokeLease: vi.fn(async () => {}), call: vi.fn(async () => null), resolveSession: vi.fn(() => resolved.promise) }
    const activation = createRuntimePanelActivation({ client, pluginId: "cogpit.github", digest: "a".repeat(64), projectId: "p_project", workspacePath: "/workspace/nested", contextEpoch: "epoch", active: true, onLoaded: vi.fn(), onError: vi.fn(), openSession })
    running.add(activation)
    await settle()
    expect(client.lease).toHaveBeenCalledWith("cogpit.github", "p_project", "epoch", expect.any(AbortSignal), "/workspace/nested")
    const request: PluginRequest = { protocol: 1, type: "request", id: "navigate", method: "navigation.openSession", params: { handle: "opaque" } }
    const result = activation.execute(request, new AbortController().signal)
    await settle()
    expect(openSession).not.toHaveBeenCalled()
    resolved.resolve({ dirName: "project", fileName: "session.jsonl" })
    await expect(result).resolves.toBeNull()
    expect(openSession).toHaveBeenCalledWith("project", "session.jsonl")
  })
  it("suppresses a late session resolution after switching panels", async () => {
    const openSession = vi.fn(), resolved = deferred<{ dirName: string; fileName: string }>()
    const client = { lease: vi.fn(async () => ({ id: "lease-1", expiresAt: Date.now() + 30000 })), payload: vi.fn(async () => new ArrayBuffer(2)), renewLease: vi.fn(), revokeLease: vi.fn(async () => {}), call: vi.fn(async () => null), resolveSession: vi.fn(() => resolved.promise) }
    const activation = createRuntimePanelActivation({ client, pluginId: "cogpit.github", digest: "a".repeat(64), projectId: "p_project", contextEpoch: "epoch", active: true, onLoaded: vi.fn(), onError: vi.fn(), openSession })
    running.add(activation)
    await settle()
    const result = activation.execute({ protocol: 1, type: "request", id: "navigate", method: "navigation.openSession", params: { handle: "opaque" } }, new AbortController().signal)
    await settle()
    activation.setActive(false)
    resolved.resolve({ dirName: "project", fileName: "session.jsonl" })
    await expect(result).rejects.toThrow()
    expect(openSession).not.toHaveBeenCalled()
  })
})
