import { createElement, type ReactNode } from "react"
import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { VercelDeploymentsResponse } from "@cogpit/plugin-integrations"
import { createVercelDeploymentsStore, VercelDeploymentsProvider, useVercelDeployments, type VercelDeploymentsStore, type VercelRequest } from "../vercelDeploymentsStore"

const data: VercelDeploymentsResponse = { projectId: "prj_test", projectName: "Example", teamId: "team_test", projectUrl: null, deployments: [] }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
const stores: VercelDeploymentsStore[] = []
function fixture(request = vi.fn<VercelRequest>().mockResolvedValue(data)) {
  const store = createVercelDeploymentsStore(request); stores.push(store)
  const wrapper = ({ children }: { children: ReactNode }) => createElement(VercelDeploymentsProvider, { value: store }, children)
  return { store, request, wrapper }
}
beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
afterEach(() => { for (const store of stores.splice(0)) store.dispose(); vi.useRealTimers(); vi.restoreAllMocks() })

describe("Vercel deployments store", () => {
  it("detects a new link on the next poll without flashing the loading screen", async () => {
    const linked = deferred<VercelDeploymentsResponse>()
    const value = fixture(vi.fn<VercelRequest>()
      .mockRejectedValueOnce({ error: "Link this project", code: "vercel_project_unlinked" })
      .mockReturnValueOnce(linked.promise))
    const { result, unmount } = renderHook(() => useVercelDeployments("project", true), { wrapper: value.wrapper })
    await waitFor(() => expect(result.current.error?.code).toBe("vercel_project_unlinked"))
    await value.store.load("project")
    expect(value.request).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(value.request).toHaveBeenCalledTimes(2)
    expect(result.current).toMatchObject({ loading: false, error: { code: "vercel_project_unlinked" } })
    await act(async () => { linked.resolve(data); await linked.promise })
    expect(result.current).toMatchObject({ data, error: null, loading: false })
    unmount()
  })
  it("checks for a new link when a hidden panel becomes visible again", async () => {
    const value = fixture(vi.fn<VercelRequest>()
      .mockRejectedValueOnce({ error: "Link this project", code: "vercel_project_unlinked" })
      .mockResolvedValue(data))
    const { result, rerender, unmount } = renderHook(({ active }) => useVercelDeployments("project", active), { initialProps: { active: true }, wrapper: value.wrapper })
    await waitFor(() => expect(result.current.error?.code).toBe("vercel_project_unlinked"))
    rerender({ active: false })
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(value.request).toHaveBeenCalledTimes(1)
    rerender({ active: true })
    await waitFor(() => expect(result.current.data).toEqual(data))
    expect(value.request).toHaveBeenCalledTimes(2)
    unmount()
  })
  it("stops automatic polling for setup errors and retries on explicit refresh", async () => {
    const value = fixture(vi.fn<VercelRequest>().mockRejectedValue({ error: "Update Vercel CLI to version 50.5.1 or newer to view deployments safely", code: "vercel_cli_too_old" }))
    const { result, unmount } = renderHook(() => useVercelDeployments("project", true), { wrapper: value.wrapper })
    await waitFor(() => expect(result.current.error?.code).toBe("vercel_cli_too_old"))
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(value.request).toHaveBeenCalledTimes(1)
    await act(async () => result.current.refresh())
    expect(value.request).toHaveBeenCalledTimes(2)
    unmount()
  })
  it("coalesces concurrent reads, keeps the eight-second cache, and polls after ten seconds", async () => {
    const value = fixture()
    const { unmount } = renderHook(() => useVercelDeployments("project", true), { wrapper: value.wrapper })
    await act(async () => { await Promise.all([value.store.load("project"), value.store.load("project")]) })
    expect(value.request).toHaveBeenCalledTimes(1)
    expect(value.request).toHaveBeenCalledWith("project", { integration: "vercel", operation: "deployments", limit: 20 }, expect.any(AbortSignal))
    await value.store.load("project")
    expect(value.request).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(value.request).toHaveBeenCalledTimes(2)
    unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    expect(value.request).toHaveBeenCalledTimes(2)
  })
  it("does not fetch when hidden or without a selected project", async () => {
    const value = fixture()
    const first = renderHook(() => useVercelDeployments(null, true), { wrapper: value.wrapper })
    const second = renderHook(() => useVercelDeployments("project", false), { wrapper: value.wrapper })
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    expect(value.request).not.toHaveBeenCalled()
    first.unmount(); second.unmount()
  })
  it("does not cross project caches when an old response completes late", async () => {
    const old = deferred<VercelDeploymentsResponse>()
    const value = fixture(vi.fn<VercelRequest>().mockImplementation(path => path === "old" ? old.promise : Promise.resolve({ ...data, projectId: "prj_new" })))
    const { result, rerender, unmount } = renderHook(({ path }) => useVercelDeployments(path, true), { initialProps: { path: "old" }, wrapper: value.wrapper })
    rerender({ path: "new" })
    await waitFor(() => expect(result.current.data?.projectId).toBe("prj_new"))
    await act(async () => { old.resolve(data); await old.promise })
    expect(result.current.data?.projectId).toBe("prj_new")
    unmount()
  })
  it("retains the last deployments after a transient refresh failure", async () => {
    const value = fixture(); await value.store.load("project")
    value.request.mockRejectedValue({ error: "Unavailable", code: "vercel_api_failed" })
    await value.store.load("project", true)
    expect(value.store.snapshot("project")).toMatchObject({ data, error: { error: "Unavailable" }, refreshing: false })
  })
  it("aborts disposed requests and ignores late results", async () => {
    const pending = deferred<VercelDeploymentsResponse>()
    const value = fixture(vi.fn<VercelRequest>().mockReturnValue(pending.promise))
    const listener = vi.fn(); value.store.subscribe("project", listener)
    const loaded = value.store.load("project"); await Promise.resolve()
    const signal = value.request.mock.calls[0]![2]
    value.store.dispose(); listener.mockClear(); pending.resolve(data); await loaded
    expect(signal.aborted).toBe(true)
    expect(listener).not.toHaveBeenCalled()
    expect(value.store.snapshot("project").data).toBeNull()
  })
  it("loads selected deployment logs with bounded arguments and caller cancellation", async () => {
    const pending = deferred<ReturnType<VercelRequest> extends Promise<infer T> ? T : never>()
    const value = fixture(vi.fn<VercelRequest>().mockReturnValue(pending.promise))
    const abort = new AbortController()
    const request = value.store.fetchBuildLogs("project", "dpl_test", abort.signal)
    const rejected = expect(request).rejects.toThrow()
    expect(value.request).toHaveBeenCalledWith("project", { integration: "vercel", operation: "buildLogs", deploymentId: "dpl_test", limit: 200 }, expect.any(AbortSignal))
    abort.abort(); expect(value.request.mock.calls[0]![2].aborted).toBe(true)
    pending.resolve({ deploymentId: "dpl_test", events: [] }); await rejected
  })
  it("rejects a response for another deployment", async () => {
    const value = fixture(vi.fn<VercelRequest>().mockResolvedValue({ deploymentId: "dpl_other", events: [] }))
    await expect(value.store.fetchBuildLogs("project", "dpl_test")).rejects.toMatchObject({ code: "invalid_response" })
  })
})
