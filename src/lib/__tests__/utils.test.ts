import { describe, it, expect } from "vitest"
import { cn, getEffortOptions, normalizeEffortForAgent, supportsImageInput } from "../utils"

describe("cn", () => {
  it("merges simple class names", () => {
    expect(cn("foo", "bar")).toBe("foo bar")
  })

  it("handles conditional classes", () => {
    const showHidden = false
    expect(cn("base", showHidden && "hidden", "visible")).toBe("base visible")
  })

  it("merges tailwind conflicting classes (last wins)", () => {
    expect(cn("p-4", "p-2")).toBe("p-2")
  })

  it("handles undefined and null values", () => {
    expect(cn("foo", undefined, null, "bar")).toBe("foo bar")
  })

  it("returns empty string for no args", () => {
    expect(cn()).toBe("")
  })

  it("handles array inputs", () => {
    expect(cn(["foo", "bar"])).toBe("foo bar")
  })

  it("merges conflicting tailwind color classes", () => {
    expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500")
  })
})

describe("getEffortOptions", () => {
  it("uses the selected model's supported reasoning efforts", () => {
    expect(getEffortOptions("claude").map((option) => option.value)).toEqual([
      "low", "medium", "high", "xhigh", "max",
    ])
    expect(getEffortOptions("codex", "gpt-5.6-sol").map((option) => option.value)).toEqual([
      "low", "medium", "high", "xhigh", "max", "ultra",
    ])
    expect(getEffortOptions("codex", "gpt-5.6-luna").map((option) => option.value)).toEqual([
      "low", "medium", "high", "xhigh", "max",
    ])
  })
})

describe("normalizeEffortForAgent", () => {
  it("keeps max for claude", () => {
    expect(normalizeEffortForAgent("claude", "max")).toBe("max")
  })

  it("keeps xhigh for codex", () => {
    expect(normalizeEffortForAgent("codex", "xhigh")).toBe("xhigh")
  })

  it("keeps xhigh for claude now that the CLI supports it", () => {
    expect(normalizeEffortForAgent("claude", "xhigh")).toBe("xhigh")
  })

  it("falls back to high for unsupported efforts", () => {
    expect(normalizeEffortForAgent("claude", "bogus")).toBe("high")
  })

  it("uses the model-recommended effort when no override is selected", () => {
    expect(normalizeEffortForAgent("codex", "", "gpt-5.6-sol")).toBe("medium")
  })

  it("drops Ultra when the selected model does not support it", () => {
    expect(normalizeEffortForAgent("codex", "ultra", "gpt-5.6-luna")).toBe("medium")
  })

  it("uses the live-catalog fallback limits for Spark", () => {
    expect(getEffortOptions("codex", "gpt-5.3-codex-spark").map((option) => option.value)).toEqual([
      "low", "medium", "high", "xhigh",
    ])
    expect(normalizeEffortForAgent("codex", "", "gpt-5.3-codex-spark")).toBe("high")
    expect(supportsImageInput("codex", "gpt-5.3-codex-spark")).toBe(false)
  })
})
