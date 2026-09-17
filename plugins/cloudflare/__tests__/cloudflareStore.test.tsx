import { createElement, type ReactNode } from "react"
import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CloudflareDeploymentsResponse, CloudflareWorkspace } from "@cogpit/plugin-integrations"
import { CloudflareProvider, createCloudflareStore, useCloudflare, type CloudflareRequest, type CloudflareStore } from "../cloudflareStore"

const VERSION_ID = "a5d6631d-f96f-4917-bec2-5a31678c58fe"
const workspace: CloudflareWorkspace = {
  workerName: "api", configPath: "wrangler.jsonc", configs: ["wrangler.jsonc"],
  environments: [{ name: null, workerName: "api", routes: [], crons: [], bindings: [], compatibilityDate: "2026-01-01", dashboardUrl: null }, { name: "staging", workerName: "api-staging", routes: [], crons: [], bindings: [], compatibilityDate: "2026-01-01", dashboardUrl: null }],
  email: "dev@example.com", account: { id: "48a839769a4ad0a20e5d71f2950d1b4d", name: "Dev" },
}
const deployments: CloudflareDeploymentsResponse = { workerName: "api", environment: null, deployments: [] }
const staging: CloudflareDeploymentsResponse = { workerName: "api-staging", environment: "staging", deployments: [] }
function respond(input: Parameters<CloudflareRequest>[1]) {
  if (input.operation === "workspace") return workspace
  if (input.operation === "deployments") return input.environment === "staging" ? staging : deployments
  return { version: { id: input.versionId, number: 1, createdAt: "2026-09-06T11:29:55.780132Z", source: "wrangler", author: "", message: null, tag: null, triggeredBy: null, hasPreview: true, compatibilityDate: null, compatibilityFlags: [], handlers: [], usageModel: null, bindings: [] } }
}
const stores: CloudflareStore[] = []
function fixture(request = vi.fn<CloudflareRequest>().mockImplementation(async (_key, input) => respond(input))) {
  const store = createCloudflareStore(request); stores.push(store)
  const wrapper = ({ children }: { children: ReactNode }) => createElement(CloudflareProvider, { value: store }, children)
  return { store, request, wrapper }
}
const operations = (request: ReturnType<typeof vi.fn<CloudflareRequest>>) => request.mock.calls.map(call => call[1].operation)
beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
afterEach(() => { for (const store of stores.splice(0)) store.dispose(); vi.useRealTimers(); vi.restoreAllMocks() })

describe("Cloudflare store", () => {
  it("describes the workspace once and reads deployments for the selected environment", async () => {
    const value = fixture()
    const { result, rerender, unmount } = renderHook(({ environment }) => useCloudflare("project", null, environment, true), { initialProps: { environment: null as string | null }, wrapper: value.wrapper })
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.deployments).toEqual(deployments))
    expect(result.current).toMatchObject({ workspace, error: null, loading: false, refreshing: false })
    expect(operations(value.request)).toEqual(["workspace", "deployments"])
    rerender({ environment: "staging" })
    await waitFor(() => expect(result.current.deployments).toEqual(staging))
    expect(operations(value.request)).toEqual(["workspace", "deployments", "deployments"])
    expect(value.request.mock.calls[2][1]).toMatchObject({ operation: "deployments", environment: "staging", limit: 20 })
    unmount()
  })

  it("keeps a separate workspace and deployments entry per selected configuration", async () => {
    const value = fixture()
    const { result, rerender, unmount } = renderHook(({ config }) => useCloudflare("project", config, null, true), { initialProps: { config: null as string | null }, wrapper: value.wrapper })
    await waitFor(() => expect(result.current.deployments).toEqual(deployments))
    rerender({ config: "services/router/wrangler.toml" })
    await waitFor(() => expect(value.request).toHaveBeenCalledTimes(4))
    expect(value.request.mock.calls[2][1]).toEqual({ integration: "cloudflare", operation: "workspace", config: "services/router/wrangler.toml" })
    expect(value.request.mock.calls[3][1]).toMatchObject({ operation: "deployments", config: "services/router/wrangler.toml" })
    rerender({ config: null })
    expect(result.current.deployments).toEqual(deployments)
    expect(value.request).toHaveBeenCalledTimes(4)
    unmount()
  })

  it("polls every thirty seconds while visible and refreshes the workspace on an explicit refresh", async () => {
    const value = fixture()
    const { result, unmount } = renderHook(() => useCloudflare("project", null, null, true), { wrapper: value.wrapper })
    await waitFor(() => expect(result.current.deployments).toEqual(deployments))
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(operations(value.request)).toEqual(["workspace", "deployments", "deployments"])
    await act(async () => { await result.current.refresh() })
    expect(operations(value.request)).toEqual(["workspace", "deployments", "deployments", "workspace", "deployments"])
    unmount()
  })

  it("keeps polling a missing configuration without flashing the loading screen, then recovers", async () => {
    const value = fixture(vi.fn<CloudflareRequest>()
      .mockRejectedValueOnce({ error: "Add a wrangler.jsonc", code: "cloudflare_config_missing" })
      .mockImplementation(async (_key, input) => respond(input)))
    const { result, unmount } = renderHook(() => useCloudflare("project", null, null, true), { wrapper: value.wrapper })
    await waitFor(() => expect(result.current.error?.code).toBe("cloudflare_config_missing"))
    expect(result.current.loading).toBe(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    await waitFor(() => expect(result.current.deployments).toEqual(deployments))
    expect(result.current.error).toBeNull()
    unmount()
  })

  it("stops polling after a setup error until the user refreshes", async () => {
    const value = fixture(vi.fn<CloudflareRequest>()
      .mockRejectedValueOnce({ error: "Sign in", code: "cloudflare_auth_required" })
      .mockImplementation(async (_key, input) => respond(input)))
    const { result, unmount } = renderHook(() => useCloudflare("project", null, null, true), { wrapper: value.wrapper })
    await waitFor(() => expect(result.current.error?.code).toBe("cloudflare_auth_required"))
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000) })
    expect(value.request).toHaveBeenCalledTimes(1)
    await act(async () => { await result.current.refresh() })
    expect(result.current).toMatchObject({ deployments, error: null })
    unmount()
  })

  it("retains the workspace when only the deployments read fails", async () => {
    const value = fixture(vi.fn<CloudflareRequest>().mockImplementation(async (_key, input) => {
      if (input.operation === "deployments") throw { error: "Not deployed", code: "cloudflare_worker_missing" }
      return respond(input)
    }))
    const { result, unmount } = renderHook(() => useCloudflare("project", null, null, true), { wrapper: value.wrapper })
    await waitFor(() => expect(result.current.error?.code).toBe("cloudflare_worker_missing"))
    expect(result.current.workspace).toEqual(workspace)
    unmount()
  })

  it("does not poll while hidden and reads again when shown", async () => {
    const value = fixture()
    const { result, rerender, unmount } = renderHook(({ active }) => useCloudflare("project", null, null, active), { initialProps: { active: false }, wrapper: value.wrapper })
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(value.request).not.toHaveBeenCalled()
    rerender({ active: true })
    await waitFor(() => expect(result.current.deployments).toEqual(deployments))
    unmount()
  })

  it("fetches version details and validates the returned identity", async () => {
    const value = fixture()
    await expect(value.store.fetchVersion("project", "apps/api/wrangler.toml", "staging", VERSION_ID)).resolves.toMatchObject({ version: { id: VERSION_ID } })
    expect(value.request.mock.calls[0][1]).toEqual({ integration: "cloudflare", operation: "version", versionId: VERSION_ID, config: "apps/api/wrangler.toml", environment: "staging" })
    value.request.mockResolvedValueOnce({ version: { id: "616630a4-2edd-4ceb-8e19-100361abda6e" } } as never)
    await expect(value.store.fetchVersion("project", null, null, VERSION_ID)).rejects.toMatchObject({ code: "invalid_response" })
  })

  it("aborts pending reads on dispose", async () => {
    const signals: AbortSignal[] = []
    const value = fixture(vi.fn<CloudflareRequest>().mockImplementation((_key, _input, signal) => { signals.push(signal); return new Promise(() => {}) }))
    void value.store.load("project", null, null)
    await waitFor(() => expect(signals).toHaveLength(1))
    value.store.dispose()
    expect(signals[0].aborted).toBe(true)
    expect(value.store.snapshot("project", null, null)).toMatchObject({ deployments: null, loading: false })
  })
})
