import { describe, it, expect } from "vitest"
import { cn, getEffortOptions, normalizeEffortForAgent } from "../utils"

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
  it("exposes max for claude and xhigh only for codex", () => {
    expect(getEffortOptions("claude").map((option) => option.value)).toEqual(["low", "medium", "high", "max"])
    expect(getEffortOptions("codex").map((option) => option.value)).toEqual(["low", "medium", "high", "max", "xhigh"])
  })
})

describe("normalizeEffortForAgent", () => {
  it("keeps max for claude", () => {
    expect(normalizeEffortForAgent("claude", "max")).toBe("max")
  })

  it("keeps xhigh for codex", () => {
    expect(normalizeEffortForAgent("codex", "xhigh")).toBe("xhigh")
  })

  it("falls back to high for unsupported claude effort", () => {
    expect(normalizeEffortForAgent("claude", "xhigh")).toBe("high")
  })
})
