import { describe, it, expect } from "vitest"
import { getContextLimit } from "../../../shared/session/contextWindow"

describe("getContextLimit", () => {
  it("reports 200k for the models that have a 200k window", () => {
    expect(getContextLimit("claude-haiku-4-5-20251001")).toBe(200_000)
    expect(getContextLimit("claude-sonnet-4-5")).toBe(200_000)
    expect(getContextLimit("claude-opus-4-5")).toBe(200_000)
    expect(getContextLimit("claude-opus-4-1")).toBe(200_000)
  })

  it("reports 1m for current-generation models", () => {
    expect(getContextLimit("claude-opus-5")).toBe(1_000_000)
    expect(getContextLimit("claude-sonnet-5")).toBe(1_000_000)
    expect(getContextLimit("claude-opus-4-8")).toBe(1_000_000)
    expect(getContextLimit("claude-opus-4-6")).toBe(1_000_000)
    expect(getContextLimit("claude-opus-4-7")).toBe(1_000_000)
    expect(getContextLimit("claude-sonnet-4-6")).toBe(1_000_000)
    expect(getContextLimit("claude-fable-5")).toBe(1_000_000)
    expect(getContextLimit("claude-mythos-5")).toBe(1_000_000)
  })

  it("honours an explicit [1m] suffix on a 200k model", () => {
    expect(getContextLimit("claude-sonnet-4-5[1m]")).toBe(1_000_000)
  })

  it("treats an unknown or empty model as current-generation", () => {
    expect(getContextLimit("claude-opus-6")).toBe(1_000_000)
    expect(getContextLimit("")).toBe(1_000_000)
  })

  it("ignores a provider prefix", () => {
    expect(getContextLimit("vertex_ai/claude-haiku-4-5")).toBe(200_000)
    expect(getContextLimit("bedrock/anthropic.claude-sonnet-4-5")).toBe(200_000)
    expect(getContextLimit("vertex_ai/claude-opus-5")).toBe(1_000_000)
  })

  it("does not mistake opus-4-8 for a 200k opus-4 variant", () => {
    expect(getContextLimit("claude-opus-4-8")).not.toBe(200_000)
  })
})
