import { describe, it, expect, afterEach, vi } from "vitest"
import {
  CLAUDE_MODEL_OPTIONS,
  CODEX_MODEL_OPTIONS,
  getModelOptions,
  setDynamicModelOptions,
  subscribeModelOptions,
  resetDynamicModelOptions,
} from "../utils"

afterEach(() => {
  resetDynamicModelOptions()
})

describe("model options store", () => {
  it("returns the static fallback lists before any dynamic catalog loads", () => {
    expect(getModelOptions("claude")).toBe(CLAUDE_MODEL_OPTIONS)
    expect(getModelOptions("codex")).toBe(CODEX_MODEL_OPTIONS)
  })

  it("includes the GPT-5.6 generation in the codex fallback list", () => {
    const values = CODEX_MODEL_OPTIONS.map((o) => o.value)
    expect(values).toContain("gpt-5.6-sol")
    expect(values).toContain("gpt-5.6-terra")
    expect(values).toContain("gpt-5.6-luna")
    expect(values).toContain("")
  })

  it("swaps in a dynamic catalog per provider and notifies subscribers", () => {
    const listener = vi.fn()
    const unsubscribe = subscribeModelOptions(listener)

    const dynamic = [
      { value: "", label: "Default" },
      { value: "gpt-6", label: "GPT-6" },
    ]
    setDynamicModelOptions("codex", dynamic)

    expect(getModelOptions("codex")).toBe(dynamic)
    // Claude keeps its fallback — only codex was updated
    expect(getModelOptions("claude")).toBe(CLAUDE_MODEL_OPTIONS)
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    setDynamicModelOptions("codex", dynamic)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("ignores empty dynamic catalogs", () => {
    setDynamicModelOptions("codex", [])
    expect(getModelOptions("codex")).toBe(CODEX_MODEL_OPTIONS)
  })

  it("restores fallbacks on reset", () => {
    setDynamicModelOptions("claude", [{ value: "", label: "Default" }])
    resetDynamicModelOptions()
    expect(getModelOptions("claude")).toBe(CLAUDE_MODEL_OPTIONS)
  })
})
