import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createAccountStore, parseAccountStatus, parseAccountWorkers, useAccountWorkers, type AccountClient, type AccountStore } from "../accountStore"

const account = { id: "48a839769a4ad0a20e5d71f2950d1b4d", name: "Dev account" }
const connected = { configured: true, readOnly: false, selected: { account: { id: account.id, label: account.name } } }
const scripts = { success: true, result: [
  { id: "older", created_on: "2026-01-01T00:00:00Z", modified_on: "2026-02-01T00:00:00Z", handlers: ["fetch"], usage_model: "standard", last_deployed_from: "wrangler" },
  { id: "newer", created_on: "2026-03-01T00:00:00Z", modified_on: "2026-09-01T00:00:00Z", handlers: ["fetch", 42], usage_model: null },
  { created_on: "2026-03-01T00:00:00Z" },
] }
const stores: AccountStore[] = []
function fixture(client: Partial<AccountClient> = {}) {
  const status = vi.fn(async () => connected), workers = vi.fn(async () => scripts)
  const store = createAccountStore({ status, workers, ...client }); stores.push(store)
  return { store, status, workers }
}
beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
afterEach(() => { for (const store of stores.splice(0)) store.dispose(); vi.useRealTimers(); vi.restoreAllMocks() })

describe("account parsing", () => {
  it("reads the connection status into a selected account, an unselected one or no connection", () => {
    expect(parseAccountStatus(connected)).toEqual(account)
    expect(parseAccountStatus({ configured: true, readOnly: true, selected: {} })).toBeNull()
    expect(parseAccountStatus({ configured: false, readOnly: false, selected: {} })).toBeUndefined()
    expect(() => parseAccountStatus("nope")).toThrow()
  })

  it("keeps listing fields only, drops nameless scripts and sorts by last change", () => {
    expect(parseAccountWorkers(scripts, account)).toEqual([
      { name: "newer", createdAt: "2026-03-01T00:00:00Z", modifiedAt: "2026-09-01T00:00:00Z", handlers: ["fetch"], usageModel: null, lastDeployedFrom: null, dashboardUrl: `https://dash.cloudflare.com/${account.id}/workers/services/view/newer/production` },
      { name: "older", createdAt: "2026-01-01T00:00:00Z", modifiedAt: "2026-02-01T00:00:00Z", handlers: ["fetch"], usageModel: "standard", lastDeployedFrom: "wrangler", dashboardUrl: `https://dash.cloudflare.com/${account.id}/workers/services/view/older/production` },
    ])
    expect(() => parseAccountWorkers({ success: true }, account)).toThrow()
  })
})

describe("account store", () => {
  it("loads the connection status and Workers, polls every minute and refreshes on demand", async () => {
    const value = fixture()
    const { result, unmount } = renderHook(() => useAccountWorkers(value.store, true))
    await waitFor(() => expect(result.current.workers).toHaveLength(2))
    expect(result.current).toMatchObject({ account, error: null, loading: false, refreshing: false })
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(value.workers).toHaveBeenCalledTimes(2)
    await act(async () => { await result.current.refresh() })
    expect(value.workers).toHaveBeenCalledTimes(3)
    unmount()
  })

  it("stops polling on setup errors until refreshed and maps host connection codes", async () => {
    const value = fixture({ status: vi.fn().mockResolvedValueOnce({ configured: false, readOnly: false, selected: {} }).mockResolvedValue(connected) })
    const { result, unmount } = renderHook(() => useAccountWorkers(value.store, true))
    await waitFor(() => expect(result.current.error?.code).toBe("cloudflare_not_connected"))
    await act(async () => { await vi.advanceTimersByTimeAsync(180_000) })
    expect(value.workers).not.toHaveBeenCalled()
    await act(async () => { await result.current.refresh() })
    expect(result.current.workers).toHaveLength(2)
    unmount()
    const denied = fixture({ workers: vi.fn().mockRejectedValue({ code: "RESOURCE_REQUIRED" }) })
    await denied.store.load()
    expect(denied.store.snapshot().error?.code).toBe("cloudflare_account_unselected")
    const failed = fixture({ workers: vi.fn().mockRejectedValue(new Error("boom")) })
    await failed.store.load()
    expect(failed.store.snapshot().error).toEqual({ code: "cloudflare_api_failed", error: "Unable to list Workers for this account." })
  })

  it("does nothing without a store or while inactive", async () => {
    const value = fixture()
    const { result, rerender, unmount } = renderHook(({ active }) => useAccountWorkers(value.store, active), { initialProps: { active: false } })
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
    expect(value.status).not.toHaveBeenCalled()
    rerender({ active: true })
    await waitFor(() => expect(result.current.workers).toHaveLength(2))
    unmount()
    const { result: none } = renderHook(() => useAccountWorkers(null, true))
    expect(none.current.workers).toBeNull()
  })
})
