import { describe, it, expect, afterEach, vi } from "vitest"
import { fallbackModelsFor } from "@/lib/agents/models"
import {
  getEffortOptions,
  getModelOptions,
  supportsImageInput,
  setDynamicModelOptions,
  subscribeModelOptions,
  resetDynamicModelOptions,
} from "../utils"

afterEach(() => {
  resetDynamicModelOptions()
})

describe("model options store", () => {
  it("returns the static fallback lists before any dynamic catalog loads", () => {
    expect(getModelOptions("claude")).toBe(fallbackModelsFor("claude"))
    expect(getModelOptions("codex")).toBe(fallbackModelsFor("codex"))
    expect(getModelOptions("copilot")).toBe(fallbackModelsFor("copilot"))
  })

  it("includes the GPT-5.6 generation in the codex fallback list", () => {
    const values = fallbackModelsFor("codex").map((o) => o.value)
    expect(values).toContain("gpt-5.6-sol")
    expect(values).toContain("gpt-5.6-terra")
    expect(values).toContain("gpt-5.6-luna")
    expect(values).toContain("")
  })

  it("keeps Copilot fallbacks minimal and conservative until the live catalog loads", () => {
    const copilot = getModelOptions("copilot")
    expect(fallbackModelsFor("copilot").map((option) => option.value)).toEqual(["", "auto"])
    expect(getEffortOptions("copilot", copilot, "")).toEqual([])
    expect(getEffortOptions("copilot", copilot, "auto")).toEqual([])
    expect(getEffortOptions("copilot", copilot, "stale-model")).toEqual([])
    expect(supportsImageInput("copilot", copilot, "")).toBe(false)
    expect(supportsImageInput("copilot", copilot, "auto")).toBe(false)
    expect(supportsImageInput("copilot", copilot, "stale-model")).toBe(false)
  })

  it("enables Copilot capabilities only when the live catalog advertises them", () => {
    setDynamicModelOptions("copilot", [{
      value: "vision-reasoning-model",
      label: "Vision Reasoning Model",
      supportsEffort: true,
      supportedReasoningEfforts: [{ value: "low", label: "Light" }],
      inputModalities: ["text", "image"],
    }])

    const copilot = getModelOptions("copilot")
    expect(getEffortOptions("copilot", copilot, "vision-reasoning-model")).toEqual([
      { value: "low", label: "Light" },
    ])
    expect(supportsImageInput("copilot", copilot, "vision-reasoning-model")).toBe(true)
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
    expect(getModelOptions("claude")).toBe(fallbackModelsFor("claude"))
    expect(getModelOptions("copilot")).toBe(fallbackModelsFor("copilot"))
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    setDynamicModelOptions("codex", dynamic)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("ignores empty dynamic catalogs", () => {
    setDynamicModelOptions("codex", [])
    expect(getModelOptions("codex")).toBe(fallbackModelsFor("codex"))
  })

  it("restores fallbacks on reset", () => {
    setDynamicModelOptions("claude", [{ value: "", label: "Default" }])
    setDynamicModelOptions("copilot", [{ value: "auto", label: "Auto" }])
    resetDynamicModelOptions()
    expect(getModelOptions("claude")).toBe(fallbackModelsFor("claude"))
    expect(getModelOptions("copilot")).toBe(fallbackModelsFor("copilot"))
  })
})
