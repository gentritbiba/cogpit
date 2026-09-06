// @vitest-environment node
import { describe, expect, it } from "vitest"
import { appendToSystemPrompt } from "../../agents/sdk"

describe("appendToSystemPrompt", () => {
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
