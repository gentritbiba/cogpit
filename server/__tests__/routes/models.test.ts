// @vitest-environment node
import { describe, it, expect } from "vitest"
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk"

import { mapClaudeModels, mapCodexModels, type CodexModel } from "../../routes/models"

describe("mapClaudeModels", () => {
  const sdkModels: ModelInfo[] = [
    {
      value: "default",
      displayName: "Default (recommended)",
      description: "Opus 4.8 with 1M context · Best for everyday, complex tasks",
    },
    {
      value: "claude-fable-5[1m]",
      displayName: "Fable",
      description: "Fable 5 · Most capable for your hardest tasks",
    },
    { value: "sonnet", displayName: "Sonnet", description: "Sonnet 4.6 · Efficient" },
    { value: "haiku", displayName: "Haiku", description: "Haiku 4.5 · Fastest" },
  ]

  it("maps the SDK 'default' pseudo-model to the empty value", () => {
    const options = mapClaudeModels(sdkModels)!
    expect(options[0]).toMatchObject({ value: "", label: "Default" })
  })

  it("keeps real models with their display names and descriptions", () => {
    const options = mapClaudeModels(sdkModels)!
    expect(options).toContainEqual({
      value: "claude-fable-5[1m]",
      label: "Fable",
      description: "Fable 5 · Most capable for your hardest tasks",
    })
    expect(options.map((o) => o.value)).toEqual(["", "claude-fable-5[1m]", "sonnet", "haiku"])
  })

  it("preserves Claude capability flags for effort, Fast, and Auto controls", () => {
    const options = mapClaudeModels([sdkModels[0], {
      value: "opus",
      displayName: "Opus",
      description: "Deep reasoning",
      supportsEffort: true,
      supportedEffortLevels: ["low", "high", "xhigh", "max"],
      supportsAdaptiveThinking: true,
      supportsFastMode: true,
      supportsAutoMode: true,
    }])!

    expect(options[1]).toMatchObject({
      value: "opus",
      supportsEffort: true,
      supportsAdaptiveThinking: true,
      supportsAutoMode: true,
      supportedReasoningEfforts: [
        { value: "low", label: "Light" },
        { value: "high", label: "High" },
        { value: "xhigh", label: "Extra High" },
        { value: "max", label: "Max" },
      ],
      serviceTiers: [{ value: "fast", label: "Fast" }],
    })
  })

  it("returns null for empty or useless input", () => {
    expect(mapClaudeModels([])).toBeNull()
    expect(mapClaudeModels(undefined as unknown as ModelInfo[])).toBeNull()
    // Only a default entry → nothing worth swapping in
    expect(mapClaudeModels([sdkModels[0]])).toBeNull()
  })

  it("skips malformed entries", () => {
    const options = mapClaudeModels([
      { value: "", displayName: "" } as ModelInfo,
      ...sdkModels,
    ])!
    expect(options.map((o) => o.value)).toEqual(["", "claude-fable-5[1m]", "sonnet", "haiku"])
  })
})

describe("mapCodexModels", () => {
  const codexModels: CodexModel[] = [
    {
      id: "gpt-5.6-terra",
      model: "gpt-5.6-terra",
      displayName: "GPT-5.6-Terra",
      description: "Balanced agentic coding model.",
      hidden: false,
      isDefault: false,
    },
    {
      id: "gpt-5.6-sol",
      model: "gpt-5.6-sol",
      displayName: "GPT-5.6-Sol",
      description: "Latest frontier agentic coding model.",
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { reasoningEffort: "medium", description: "Balanced" },
        { reasoningEffort: "ultra", description: "Automatic task delegation" },
      ],
      inputModalities: ["text", "image"],
      supportsPersonality: false,
      serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed" }],
      availabilityNux: { message: "Our most capable model yet." },
    },
    {
      id: "gpt-secret",
      model: "gpt-secret",
      displayName: "Secret",
      hidden: true,
      isDefault: false,
    },
    {
      id: "gpt-5.3-codex-spark",
      model: "gpt-5.3-codex-spark",
      displayName: "GPT-5.3-Codex-Spark",
      description: "Ultra-fast coding model.",
      hidden: false,
      isDefault: false,
    },
  ]

  it("prepends an empty Default option and puts the default model first", () => {
    const options = mapCodexModels(codexModels)!
    expect(options[0]).toMatchObject({
      value: "",
      label: "Default",
      isDefault: true,
      defaultReasoningEffort: "medium",
    })
    expect(options[1].value).toBe("gpt-5.6-sol")
  })

  it("preserves model capabilities for capability-driven controls", () => {
    const sol = mapCodexModels(codexModels)!.find((option) => option.value === "gpt-5.6-sol")!
    expect(sol.supportedReasoningEfforts).toEqual([
      { value: "medium", label: "Medium", description: "Balanced" },
      { value: "ultra", label: "Ultra", description: "Automatic task delegation" },
    ])
    expect(sol.inputModalities).toEqual(["text", "image"])
    expect(sol.supportsPersonality).toBe(false)
    expect(sol.serviceTiers).toEqual([
      { value: "priority", label: "Fast", description: "1.5x speed" },
    ])
    expect(sol.availabilityMessage).toBe("Our most capable model yet.")
  })

  it("filters hidden models", () => {
    const options = mapCodexModels(codexModels)!
    expect(options.some((o) => o.value === "gpt-secret")).toBe(false)
  })

  it("converts dashed display names to spaced labels", () => {
    const options = mapCodexModels(codexModels)!
    expect(options.find((o) => o.value === "gpt-5.6-sol")?.label).toBe("GPT-5.6 Sol")
    expect(options.find((o) => o.value === "gpt-5.3-codex-spark")?.label).toBe("GPT-5.3 Codex Spark")
  })

  it("returns null when nothing is visible", () => {
    expect(mapCodexModels([])).toBeNull()
    expect(mapCodexModels([codexModels[2]])).toBeNull()
  })
})
