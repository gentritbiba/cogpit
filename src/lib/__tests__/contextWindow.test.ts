import { describe, it, expect } from "vitest"
import { computeContextUsage, getContextLimit } from "../../../shared/session/contextWindow"

describe("getContextLimit", () => {
  it("reports 200k for the models that have a 200k window", () => {
    expect(getContextLimit("claude-haiku-4-5-20251001", "claude")).toBe(200_000)
    expect(getContextLimit("claude-sonnet-4-5", "claude")).toBe(200_000)
    expect(getContextLimit("claude-opus-4-5", "claude")).toBe(200_000)
    expect(getContextLimit("claude-opus-4-1", "claude")).toBe(200_000)
  })

  it("reports 1m for current-generation models", () => {
    expect(getContextLimit("claude-opus-5", "claude")).toBe(1_000_000)
    expect(getContextLimit("claude-sonnet-5", "claude")).toBe(1_000_000)
    expect(getContextLimit("claude-opus-4-8", "claude")).toBe(1_000_000)
    expect(getContextLimit("claude-opus-4-6", "claude")).toBe(1_000_000)
    expect(getContextLimit("claude-opus-4-7", "claude")).toBe(1_000_000)
    expect(getContextLimit("claude-sonnet-4-6", "claude")).toBe(1_000_000)
    expect(getContextLimit("claude-fable-5", "claude")).toBe(1_000_000)
    expect(getContextLimit("claude-mythos-5", "claude")).toBe(1_000_000)
  })

  it("honours an explicit [1m] suffix on a 200k model", () => {
    expect(getContextLimit("claude-sonnet-4-5[1m]", "claude")).toBe(1_000_000)
  })

  it("treats an unknown or empty model as current-generation", () => {
    expect(getContextLimit("claude-opus-6", "claude")).toBe(1_000_000)
    expect(getContextLimit("", "claude")).toBe(1_000_000)
  })

  it("ignores a provider prefix", () => {
    expect(getContextLimit("vertex_ai/claude-haiku-4-5", "claude")).toBe(200_000)
    expect(getContextLimit("bedrock/anthropic.claude-sonnet-4-5", "claude")).toBe(200_000)
    expect(getContextLimit("vertex_ai/claude-opus-5", "claude")).toBe(1_000_000)
  })

  it("does not mistake opus-4-8 for a 200k opus-4 variant", () => {
    expect(getContextLimit("claude-opus-4-8", "claude")).not.toBe(200_000)
  })

  it("gives each agent its own window and compaction reserve", () => {
    // A Codex or Copilot model used to inherit Claude's 1M default and its 33k
    // auto-compaction reserve, so every session reported the wrong headroom.
    expect(getContextLimit("gpt-5.6-sol", "codex")).toBe(272_000)
    expect(getContextLimit("gpt-5.6-sol", "copilot")).toBe(200_000)
    expect(computeContextUsage({ input_tokens: 1_000 }, "gpt-5.6-sol", "codex").compactAt)
      .toBe(272_000)
    expect(computeContextUsage({ input_tokens: 1_000 }, "claude-opus-5", "claude").compactAt)
      .toBe(1_000_000 - 33_000)
  })

  it("does not apply another agent's extended-context marker", () => {
    expect(getContextLimit("some-model[1m]", "codex")).toBe(272_000)
  })
})
