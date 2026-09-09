import { beforeEach, describe, expect, it, vi } from "vitest"

import { makeProviderUpdateInfo } from "@/__tests__/fixtures"
import {
  fetchProviderUpdates,
  nextDismissals,
  pendingProviderUpdates,
  providerUpdateDismissKey,
  runProviderUpdate,
} from "../providerUpdates"

const mockAuthFetch = vi.hoisted(() => vi.fn())
const mockJsonFetch = vi.hoisted(() => vi.fn())
vi.mock("../auth", () => ({ authFetch: mockAuthFetch, jsonFetch: mockJsonFetch }))

describe("pendingProviderUpdates", () => {
  it("keeps only outdated providers", () => {
    const providers = [
      makeProviderUpdateInfo(),
      makeProviderUpdateInfo({ provider: "codex", status: "current" }),
      makeProviderUpdateInfo({ provider: "codex", status: "not-installed", latestVersion: null }),
      makeProviderUpdateInfo({ provider: "copilot", status: "behind" }),
    ]
    expect(pendingProviderUpdates(providers, []).map((info) => info.provider)).toEqual(["claude", "copilot"])
  })

  it("hides a version the user dismissed but returns for the next one", () => {
    const behind = makeProviderUpdateInfo()
    const dismissed = [providerUpdateDismissKey(behind)]
    expect(pendingProviderUpdates([behind], dismissed)).toEqual([])
    expect(
      pendingProviderUpdates([makeProviderUpdateInfo({ latestVersion: "2.1.21" })], dismissed),
    ).toHaveLength(1)
  })
})

describe("nextDismissals", () => {
  it("replaces the provider's older entry and leaves others alone", () => {
    expect(nextDismissals([], "claude:2.1.20")).toEqual(["claude:2.1.20"])
    expect(nextDismissals(["claude:2.1.20", "codex:0.52.0"], "claude:2.1.21")).toEqual([
      "codex:0.52.0",
      "claude:2.1.21",
    ])
  })
})

describe("api calls", () => {
  beforeEach(() => {
    mockAuthFetch.mockReset()
    mockJsonFetch.mockReset()
  })

  it("unwraps the advisory list", async () => {
    mockAuthFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ providers: [makeProviderUpdateInfo()] }),
    })
    expect(await fetchProviderUpdates()).toHaveLength(1)
  })

  it("throws when the check fails", async () => {
    mockAuthFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) })
    await expect(fetchProviderUpdates()).rejects.toThrow("503")
  })

  it("posts the provider id and returns the run result", async () => {
    mockJsonFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ provider: "copilot", status: "succeeded", message: "done", output: null }),
    })
    const result = await runProviderUpdate("copilot")
    expect(result.status).toBe("succeeded")
    expect(mockJsonFetch).toHaveBeenCalledWith("/api/provider-updates/run", { provider: "copilot" })
  })

  it("surfaces a server error body as a thrown message", async () => {
    mockJsonFetch.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: "Admin access required" }),
    })
    await expect(runProviderUpdate("claude")).rejects.toThrow("Admin access required")
  })
})
