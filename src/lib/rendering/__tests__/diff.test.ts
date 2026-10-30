// @vitest-environment node
import { describe, expect, it } from "vitest"
import { computeDiff, computeDiffDeferred } from "../diff"
import { splitDiffLines } from "../../../../shared/diff-utils"

describe("canonical line diff", () => {
  it.each([
    ["", ""], ["", "\n"], ["\n", ""], ["a\r\nb\r\n", "a\r\nc\r\n"],
    ["a\nb\na\n", "b\na\nb\n"], ["a\r", "a\n"],
    ["same\nold\nsuffix", "same\nnew\nsuffix"],
  ])("preserves both source sequences and indexes: %j to %j", async (oldText, newText) => {
    const result = computeDiff(oldText, newText)
    expect(result.filter(line => line.type !== "added").map(line => line.text)).toEqual(splitDiffLines(oldText))
    expect(result.filter(line => line.type !== "removed").map(line => line.text)).toEqual(splitDiffLines(newText))
    for (const line of result) {
      if (line.oldIdx !== undefined) expect(line.text).toBe(splitDiffLines(oldText)[line.oldIdx])
      if (line.newIdx !== undefined) expect(line.text).toBe(splitDiffLines(newText)[line.newIdx])
    }
    expect(await computeDiffDeferred(oldText, newText)).toEqual(result)
  })

  it("keeps the original LCS tie ordering", () => {
    expect(computeDiff("a\nb", "b\na")).toEqual([
      { type: "removed", text: "a", oldIdx: 0 },
      { type: "unchanged", text: "b", oldIdx: 1, newIdx: 0 },
      { type: "added", text: "a", newIdx: 1 },
    ])
  })

  it("keeps prefix/suffix locations around the large-input removed/added fast path", () => {
    const oldText = "start\n" + Array.from({ length: 600 }, (_, i) => `old ${i}`).join("\n") + "\nend"
    const newText = "start\n" + Array.from({ length: 600 }, (_, i) => `new ${i}`).join("\n") + "\nend"
    const result = computeDiff(oldText, newText)
    expect(result).toHaveLength(1202)
    expect(result[0]).toEqual({ type: "unchanged", text: "start", oldIdx: 0, newIdx: 0 })
    expect(result[600]).toEqual({ type: "removed", text: "old 599", oldIdx: 600 })
    expect(result[601]).toEqual({ type: "added", text: "new 0", newIdx: 1 })
    expect(result.at(-1)).toEqual({ type: "unchanged", text: "end", oldIdx: 601, newIdx: 601 })
  })

  it("handles a long narrow LCS without an argument-stack overflow", () => {
    const result = computeDiff("old", "new\n".repeat(200_000))
    expect(result).toHaveLength(200_001)
  })

  it("cooperative fallback yields and cancels without completing obsolete large work", async () => {
    const controller = new AbortController()
    const work = computeDiffDeferred("a\n".repeat(100_000), "b\n".repeat(100_000), controller.signal)
    setTimeout(() => controller.abort(), 0)
    await expect(work).rejects.toMatchObject({ name: "AbortError" })
  })
})
