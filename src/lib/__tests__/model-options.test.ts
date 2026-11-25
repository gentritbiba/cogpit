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

  it("lists the Codex 0.167 catalog in the codex fallback list", () => {
    expect(fallbackModelsFor("codex").map((o) => o.value)).toEqual([
      "",
      "gpt-6.2-sol",
      "gpt-6.2-astra",
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6.1-terra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ])
  })

  it("lists Claude aliases without separate 1M rows", () => {
    expect(fallbackModelsFor("claude").map((o) => o.value)).toEqual(["", "opus", "fable", "sonnet", "haiku"])
  })

  it("offers Astra without guessing the user's configured default", () => {
    const models = fallbackModelsFor("codex")
    expect(models.find((model) => model.value === "")?.resolvedModel).toBeUndefined()
    const astra = models.find((model) => model.value === "gpt-6-astra")
    expect(astra?.supportedReasoningEfforts?.map((effort) => effort.value)).toContain("ultra")
    expect(astra?.serviceTiers?.[0].description).toBe("2× speed with increased usage")
    expect(models.find((model) => model.value === "gpt-6-sol")?.serviceTiers?.[0].description).toBe("1.5× speed")
    expect(models.find((model) => model.value === "gpt-5.6-sol")?.serviceTiers?.[0].description).toBe("1.5× speed with increased usage")
    expect(models.find((model) => model.value === "gpt-6.2-sol")?.isDefault).not.toBe(true)
    expect(models.find((model) => model.value === "gpt-6.2-astra")?.serviceTiers?.[0].description).toBe("2× speed with increased usage")
    const terra = models.find((model) => model.value === "gpt-6.1-terra")
    expect(terra?.defaultReasoningEffort).toBe("low")
    expect(terra?.supportedReasoningEfforts?.map((effort) => effort.value)).toContain("ultra")
    expect(terra?.serviceTiers?.[0].description).toBe("1.5× speed")
    expect(models.find((model) => model.value === "gpt-6-luna")?.supportedReasoningEfforts?.map((effort) => effort.value))
      .not.toContain("ultra")
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

  it("offers Antigravity thinking levels only for the model the agent reported them for", () => {
    expect(getEffortOptions("antigravity", getModelOptions("antigravity"), "")).toEqual([])
    setDynamicModelOptions("antigravity", [
      { value: "", label: "Provider default", supportsEffort: false },
      { value: "gemini-3.8-flash", label: "Gemini 3.8 Flash", supportsEffort: true, supportedReasoningEfforts: [{ value: "low", label: "Low" }, { value: "high", label: "High" }] },
      { value: "gemini-pro-agent", label: "Gemini 3.1 Pro", supportsEffort: false },
    ])
    const antigravity = getModelOptions("antigravity")
    expect(getEffortOptions("antigravity", antigravity, "gemini-3.8-flash").map((effort) => effort.value)).toEqual(["low", "high"])
    expect(getEffortOptions("antigravity", antigravity, "gemini-pro-agent")).toEqual([])
    expect(getEffortOptions("antigravity", antigravity, "")).toEqual([])
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
