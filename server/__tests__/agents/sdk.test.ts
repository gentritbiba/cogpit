// @vitest-environment node
import { describe, expect, it } from "vitest"
import { appendToSystemPrompt } from "../../agents/sdk"

describe("appendToSystemPrompt", () => {
  it("preserves custom prompts and their snapshot setting", () => {
    expect(appendToSystemPrompt({ type: "custom", prompt: "Original", snapshot: false }, "extra"))
      .toEqual({ type: "custom", prompt: "Original\n\nextra", snapshot: false })
    expect(appendToSystemPrompt({ type: "custom", prompt: ["Original"], snapshot: true }, "extra"))
      .toEqual({ type: "custom", prompt: ["Original", "extra"], snapshot: true })
    expect(appendToSystemPrompt("Original", "extra")).toBe("Original\n\nextra")
    expect(appendToSystemPrompt(["Original"], "extra")).toEqual(["Original", "extra"])
  })

  it("keeps the CLI's own prompt and adds the text after it", () => {
    expect(appendToSystemPrompt(undefined, "extra")).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "extra",
    })
  })

  it("adds to an append another caller already made", () => {
    const existing = appendToSystemPrompt(undefined, "first")
    expect(appendToSystemPrompt(existing, "second")).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "first\n\nsecond",
    })
  })

  it("carries the rest of the preset options through", () => {
    const existing = { type: "preset", preset: "claude_code", excludeDynamicSections: true } as const
    expect(appendToSystemPrompt(existing, "extra")).toEqual({
      type: "preset",
      preset: "claude_code",
      excludeDynamicSections: true,
      append: "extra",
    })
  })
})
