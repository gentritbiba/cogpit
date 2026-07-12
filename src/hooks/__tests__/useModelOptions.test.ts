import { describe, it, expect, afterEach, vi } from "vitest"
import { loadModelCatalog, resetModelCatalogFetch } from "../useModelOptions"
import {
  CLAUDE_MODEL_OPTIONS,
  CODEX_MODEL_OPTIONS,
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
    mockedAuthFetch.mockResolvedValue(jsonResponse({ claude, codex }))

    await loadModelCatalog()

    expect(mockedAuthFetch).toHaveBeenCalledWith("/api/models")
    expect(getModelOptions("claude")).toEqual(claude)
    expect(getModelOptions("codex")).toEqual(codex)
  })

  it("keeps static fallbacks for providers the server could not resolve", async () => {
    const codex = [
      { value: "", label: "Default" },
      { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    ]
    mockedAuthFetch.mockResolvedValue(jsonResponse({ claude: null, codex }))

    await loadModelCatalog()

    expect(getModelOptions("claude")).toBe(CLAUDE_MODEL_OPTIONS)
    expect(getModelOptions("codex")).toEqual(codex)
  })

  it("keeps static fallbacks when the request fails", async () => {
    mockedAuthFetch.mockRejectedValue(new Error("offline"))

    await loadModelCatalog()

    expect(getModelOptions("claude")).toBe(CLAUDE_MODEL_OPTIONS)
    expect(getModelOptions("codex")).toBe(CODEX_MODEL_OPTIONS)
  })

  it("ignores malformed catalog entries", async () => {
    mockedAuthFetch.mockResolvedValue(
      jsonResponse({ claude: [{ nope: true }], codex: "not-an-array" }),
    )

    await loadModelCatalog()

    expect(getModelOptions("claude")).toBe(CLAUDE_MODEL_OPTIONS)
    expect(getModelOptions("codex")).toBe(CODEX_MODEL_OPTIONS)
  })

  it("only fetches once per page load", async () => {
    mockedAuthFetch.mockResolvedValue(jsonResponse({ claude: null, codex: null }))

    await loadModelCatalog()
    await loadModelCatalog()

    expect(mockedAuthFetch).toHaveBeenCalledTimes(1)
  })
})
