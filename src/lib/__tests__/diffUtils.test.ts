import { describe, it, expect } from "vitest"
import { diffLineCount, computeNetDiff } from "@/lib/diffUtils"
import type { EditOp } from "@/lib/diffUtils"

describe("diffLineCount", () => {
  it("returns zeros for two empty strings", () => {
    expect(diffLineCount("", "")).toEqual({ add: 0, del: 0 })
  })

  it("counts all lines as additions when old is empty", () => {
    expect(diffLineCount("", "a\nb\nc")).toEqual({ add: 3, del: 0 })
  })

  it("counts all lines as deletions when new is empty", () => {
    expect(diffLineCount("a\nb\nc", "")).toEqual({ add: 0, del: 3 })
  })

  it("counts changed lines correctly", () => {
    const { add, del } = diffLineCount("a\nb\nc", "a\nX\nc")
    expect(add).toBe(1)
    expect(del).toBe(1)
  })

  it("returns zeros for identical strings", () => {
    expect(diffLineCount("same\nlines", "same\nlines")).toEqual({ add: 0, del: 0 })
  })
})

describe("computeNetDiff", () => {
  it("returns empty result for empty ops", () => {
    const result = computeNetDiff([])
    expect(result).toEqual({
      originalStr: "",
      currentStr: "",
      addCount: 0,
      delCount: 0,
    })
  })

  it("handles a single Edit op", () => {
    const ops: EditOp[] = [
      { oldString: "foo", newString: "bar", isWrite: false },
    ]
    const result = computeNetDiff(ops)
    expect(result.originalStr).toBe("foo")
    expect(result.currentStr).toBe("bar")
  })

  it("chains edits within the same region", () => {
    // First edit: foo -> bar; second edit modifies bar -> baz
    const ops: EditOp[] = [
      { oldString: "foo", newString: "bar", isWrite: false },
      { oldString: "bar", newString: "baz", isWrite: false },
    ]
    const result = computeNetDiff(ops)
    // Net: foo -> baz
    expect(result.originalStr).toBe("foo")
    expect(result.currentStr).toBe("baz")
  })

  it("Write-only scenario: returns non-empty currentStr and correct addCount", () => {
    const content = "line one\nline two\nline three"
    const ops: EditOp[] = [
      { oldString: "", newString: content, isWrite: true },
    ]
    const result = computeNetDiff(ops)
    expect(result.currentStr).toBe(content)
    expect(result.originalStr).toBe("")
    expect(result.addCount).toBe(3)
    expect(result.delCount).toBe(0)
  })

  it("Write followed by Edit: shows net change from Write content to edited content", () => {
    const writeContent = "alpha\nbeta\ngamma"
    const ops: EditOp[] = [
      { oldString: "", newString: writeContent, isWrite: true },
      { oldString: "beta", newString: "BETA", isWrite: false },
    ]
    const result = computeNetDiff(ops)
    // The edit modifies the Write region, so original stays as the write content
    expect(result.currentStr).toContain("BETA")
  })

  it("multiple Write ops: last Write wins as baseline", () => {
    const ops: EditOp[] = [
      { oldString: "", newString: "first write\nline two", isWrite: true },
      { oldString: "", newString: "second write\nline two", isWrite: true },
    ]
    const result = computeNetDiff(ops)
    // Both writes set original=current, so no net change — but hasWrite triggers
    // the special path returning currentStr as all-new content
    expect(result.currentStr).toBe("second write\nline two")
    expect(result.addCount).toBeGreaterThan(0)
  })

  it("Edit with empty oldString creates a new region (insertion)", () => {
    const ops: EditOp[] = [
      { oldString: "", newString: "inserted line", isWrite: false },
    ]
    const result = computeNetDiff(ops)
    expect(result.originalStr).toBe("")
    expect(result.currentStr).toBe("inserted line")
    expect(result.addCount).toBeGreaterThan(0)
  })

  it("silently skips redundant edits where old_string was already transformed", () => {
    // First edit removes "old", second edit tries to remove "old" again — redundant
    const ops: EditOp[] = [
      { oldString: "old", newString: "new", isWrite: false },
      { oldString: "old", newString: "other", isWrite: false },
    ]
    const result = computeNetDiff(ops)
    // Net result is just the first edit: old -> new
    expect(result.originalStr).toBe("old")
    expect(result.currentStr).toBe("new")
  })
})
