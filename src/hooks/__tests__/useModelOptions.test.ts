import { describe, it, expect, afterEach, vi } from "vitest"
import { fallbackModelsFor } from "@/lib/agents/models"
import { loadModelCatalog, resetModelCatalogFetch } from "../useModelOptions"
import {
  getModelOptions,
  resetDynamicModelOptions,
} from "@/lib/utils"
import { authFetch } from "@/lib/auth"

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
}))

const mockedAuthFetch = vi.mocked(authFetch)

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response
}

afterEach(() => {
  resetModelCatalogFetch()
  resetDynamicModelOptions()
  vi.clearAllMocks()
})

describe("loadModelCatalog", () => {
  it("swaps in dynamic catalogs from /api/models", async () => {
    const claude = [
      { value: "", label: "Default" },
      { value: "claude-fable-5[1m]", label: "Fable" },
    ]
    const codex = [
      { value: "", label: "Default" },
      { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    ]
    const copilot = [
      { value: "", label: "Default" },
      { value: "claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
    ]
    mockedAuthFetch.mockResolvedValue(jsonResponse({ claude, codex, copilot }))

    await loadModelCatalog()

    expect(mockedAuthFetch).toHaveBeenCalledWith("/api/models")
    expect(getModelOptions("claude")).toEqual(claude)
    expect(getModelOptions("codex")).toEqual(codex)
    expect(getModelOptions("copilot")).toEqual(copilot)
  })

  it("keeps static fallbacks for providers the server could not resolve", async () => {
    const codex = [
      { value: "", label: "Default" },
      { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    ]
    mockedAuthFetch.mockResolvedValue(jsonResponse({ claude: null, codex }))

    await loadModelCatalog()

    expect(getModelOptions("claude")).toBe(fallbackModelsFor("claude"))
    expect(getModelOptions("codex")).toEqual(codex)
    expect(getModelOptions("copilot")).toBe(fallbackModelsFor("copilot"))
  })

  it("keeps static fallbacks when the request fails", async () => {
    mockedAuthFetch.mockRejectedValue(new Error("offline"))

    await loadModelCatalog()

    expect(getModelOptions("claude")).toBe(fallbackModelsFor("claude"))
    expect(getModelOptions("codex")).toBe(fallbackModelsFor("codex"))
    expect(getModelOptions("copilot")).toBe(fallbackModelsFor("copilot"))
  })

  it("ignores malformed catalog entries", async () => {
    mockedAuthFetch.mockResolvedValue(
      jsonResponse({ claude: [{ nope: true }], codex: "not-an-array", copilot: [] }),
    )

    await loadModelCatalog()

    expect(getModelOptions("claude")).toBe(fallbackModelsFor("claude"))
    expect(getModelOptions("codex")).toBe(fallbackModelsFor("codex"))
    expect(getModelOptions("copilot")).toBe(fallbackModelsFor("copilot"))
  })

  it("only fetches once per page load", async () => {
    mockedAuthFetch.mockResolvedValue(jsonResponse({ claude: null, codex: null }))

    await loadModelCatalog()
    await loadModelCatalog()

    expect(mockedAuthFetch).toHaveBeenCalledTimes(1)
  })
})
