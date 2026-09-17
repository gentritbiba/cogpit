import { act, renderHook } from "@testing-library/react"
import { StrictMode, type ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { JsonValue } from "@cogpit/plugin-sdk"
import { createClickUpRuntimeStore, parseRuntimeStatus, useRuntimeResource } from "../runtimeStore"
import { connectionStatus, deferred, fakeClient, list, rawTask, viewer } from "./runtimeFixtures"

afterEach(() => { vi.useRealTimers() })

describe("ClickUp runtime store", () => {
  it("loads only declared operations with opaque handle and bounded page args", async () => {
    const client = fakeClient(), store = createClickUpRuntimeStore(client)
    vi.mocked(client.connections.request).mockImplementation(async (_handle, operation, args): Promise<JsonValue> => {
      if (operation === "viewer") return { user: viewer }
      expect(operation).toBe("mine")
      return { tasks: [rawTask(String(args.page)), rawTask("duplicate")], last_page: args.page === 2 }
    })
    await store.mine.load()
    expect(client.connections.status).toHaveBeenCalledWith("clickup", { signal: expect.any(AbortSignal) })
    const requests = vi.mocked(client.connections.request).mock.calls
    expect(requests.map(([handle, operation, args]) => [handle, operation, args])).toEqual([
      ["clickup", "viewer", {}], ["clickup", "mine", { page: 0 }], ["clickup", "mine", { page: 1 }], ["clickup", "mine", { page: 2 }],
    ])
    expect(store.mine.getSnapshot().data?.tasks.map((task) => task.id)).toEqual(["0", "duplicate", "1", "2"])
    expect(store.mine.getSnapshot().data?.truncated).toBe(false)
    expect(store.mine.getSnapshot().data?.workspace).toEqual({ id: "10", name: "Example workspace" })
    store.dispose()
  })
  it("stops at three pages and reports truncation", async () => {
    const client = fakeClient(), store = createClickUpRuntimeStore(client)
    vi.mocked(client.connections.request).mockImplementation(async (_handle, op, args): Promise<JsonValue> => op === "viewer" ? { user: viewer } : { tasks: [rawTask(String(args.page))], last_page: false })
    await store.mine.load()
    expect(store.mine.getSnapshot().data?.truncated).toBe(true)
    expect(store.mine.getSnapshot().data?.tasks).toHaveLength(3)
    store.dispose()
  })
  it("fetches the selected list, three open pages and one recent closed page, preserving done workflow tasks", async () => {
    const client = fakeClient(), now = 2_000_000_000_000, store = createClickUpRuntimeStore(client, () => now)
    vi.mocked(client.connections.request).mockImplementation(async (_handle, op, args): Promise<JsonValue> => {
      if (op === "viewer") return { user: viewer }
      if (op === "list") return list
      if (args.closed) return { tasks: [rawTask("open"), rawTask("closed", { status: { status: "complete", type: "closed" }, date_closed: String(now) }), rawTask("done", { status: { status: "review", type: "done" } })], last_page: false }
      return { tasks: [rawTask("open")], last_page: false }
    })
    await store.project.load()
    expect(store.project.getSnapshot().data?.tasks.map((task) => task.id)).toEqual(["open", "closed"])
    expect(store.project.getSnapshot().data?.truncated).toBe(true)
    expect(client.connections.request).toHaveBeenCalledWith("clickup", "tasks", { closed: true, updatedAfter: now - 14 * 86400000, page: 0 }, { signal: expect.any(AbortSignal) })
    expect(vi.mocked(client.connections.request).mock.calls.filter(([, op, args]) => op === "tasks" && args.closed)).toHaveLength(1)
    store.dispose()
  })
  it("does not request data before parent selects a workspace or list", async () => {
    const client = fakeClient(), store = createClickUpRuntimeStore(client)
    vi.mocked(client.connections.status).mockResolvedValue({ configured: true, readOnly: false, selected: { workspace: connectionStatus.selected.workspace } })
    await store.project.load()
    expect(store.project.getSnapshot().error?.code).toBe("project_unlinked")
    expect(vi.mocked(client.connections.request).mock.calls.map(([, op]) => op)).toEqual(["viewer"])
    await store.project.load()
    expect(client.connections.status).toHaveBeenCalledTimes(1)
    store.dispose()
  })
  it("never asks for viewer credentials when disconnected", async () => {
    const client = fakeClient(), store = createClickUpRuntimeStore(client)
    vi.mocked(client.connections.status).mockResolvedValue({ configured: false, readOnly: false, selected: {} })
    await store.mine.load()
    expect(client.connections.request).not.toHaveBeenCalled()
    expect(store.mine.getSnapshot().error?.code).toBe("clickup_not_configured")
    store.dispose()
  })
  it("coalesces concurrent loads and caches for eight seconds; force refresh keeps previous data", async () => {
    let now = 100
    const client = fakeClient(), store = createClickUpRuntimeStore(client, () => now)
    await Promise.all([store.mine.load(), store.mine.load()])
    expect(client.connections.request).toHaveBeenCalledTimes(2)
    await store.mine.load()
    expect(client.connections.request).toHaveBeenCalledTimes(2)
    now += 8000
    await store.mine.load()
    expect(client.connections.request).toHaveBeenCalledTimes(4)
    const pending = deferred<JsonValue>()
    vi.mocked(client.connections.request).mockReturnValue(pending.promise)
    const refresh = store.mine.load(true)
    expect(store.mine.getSnapshot()).toMatchObject({ loading: false, refreshing: true, data: { tasks: [expect.anything()] } })
    pending.reject(new Error("private detail must stay hidden"))
    await refresh
    expect(store.mine.getSnapshot()).toMatchObject({ refreshing: false, error: { error: "Unable to load ClickUp data. Try again." }, data: { tasks: [expect.anything()] } })
    store.dispose()
  })
  it("rejects malformed response/list identity without returning raw server details", async () => {
    const client = fakeClient(), store = createClickUpRuntimeStore(client)
    vi.mocked(client.connections.request).mockImplementation(async (_h, op): Promise<JsonValue> => op === "viewer" ? { user: viewer } : op === "list" ? { ...list, id: "999" } : { tasks: [], last_page: true })
    await store.project.load()
    expect(store.project.getSnapshot().data).toBeNull()
    expect(store.project.getSnapshot().error?.code).toBe("invalid_response")
    expect(() => parseRuntimeStatus({ configured: "true" })).toThrow()
    store.dispose()
  })
  it("maps bounded broker errors and ignores provider messages", async () => {
    const client = fakeClient(), store = createClickUpRuntimeStore(client)
    vi.mocked(client.connections.status).mockRejectedValue({ code: "RATE_LIMITED", message: "sensitive upstream text" })
    await store.status.load()
    expect(store.status.getSnapshot().error).toEqual({ code: "clickup_rate_limited", error: "Too many requests. Try again shortly." })
    store.dispose()
  })
  it("aborts disposal and prevents old host/project response from entering a new store", async () => {
    const client = fakeClient(), oldStore = createClickUpRuntimeStore(client), pending = deferred<JsonValue>()
    await oldStore.status.load()
    vi.mocked(client.connections.request).mockReturnValue(pending.promise)
    const load = oldStore.mine.load()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    const signal = vi.mocked(client.connections.request).mock.calls.at(-1)![3]!.signal!
    oldStore.dispose()
    expect(signal.aborted).toBe(true)
    const nextClient = fakeClient(), nextStore = createClickUpRuntimeStore(nextClient)
    await nextStore.mine.load()
    pending.resolve({ tasks: [rawTask("old")], last_page: true })
    await load
    expect(oldStore.mine.getSnapshot().data).toBeNull()
    expect(nextStore.mine.getSnapshot().data?.tasks.map((task) => task.id)).toEqual(["1"])
    nextStore.dispose()
  })
  it("does not start a deferred load after disposal", async () => {
    const client = fakeClient(), store = createClickUpRuntimeStore(client)
    const load = store.status.load()
    store.dispose()
    await load
    expect(client.connections.status).not.toHaveBeenCalled()
  })
  it("survives StrictMode effects, pauses when inactive, and clears polling on unmount", async () => {
    vi.useFakeTimers()
    const client = fakeClient(), store = createClickUpRuntimeStore(client)
    const hook = renderHook(({ active }) => useRuntimeResource(store.mine, active), { initialProps: { active: true }, wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode> })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(hook.result.current.data?.tasks).toHaveLength(1)
    expect(client.connections.request).toHaveBeenCalledTimes(2)
    hook.rerender({ active: false })
    await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
    expect(client.connections.request).toHaveBeenCalledTimes(2)
    hook.rerender({ active: true })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(client.connections.request).toHaveBeenCalledTimes(4)
    hook.unmount()
    expect(vi.getTimerCount()).toBe(0)
    store.dispose()
  })
})
