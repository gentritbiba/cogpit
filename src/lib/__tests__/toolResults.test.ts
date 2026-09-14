import { describe, expect, it } from "vitest"
import { computeNetDiff } from "../../../shared/diff-utils"
import { formatToolFileDiff, toolDiffEdits, toolResultMetadata } from "../../../shared/session/toolResults"

describe("toolResultMetadata", () => {
  it("only treats an explicit staged flag on file-edit tools as awaiting review", () => {
    expect(toolResultMetadata("Edit", { staged: true })).toEqual({ awaitingReview: true })
    expect(toolResultMetadata("Write", { staged: true })).toEqual({ awaitingReview: true })
    expect(toolResultMetadata("Read", { staged: true })).toEqual({})
    expect(toolResultMetadata("Edit", { staged: "true" })).toEqual({})
    expect(toolResultMetadata("Write", { staged: false })).toEqual({})
  })

  it("ignores malformed diff entries while preserving valid hunks and line positions", () => {
    const good = { oldStart: 15, oldLines: 1, newStart: 15, newLines: 1, lines: ["-old", "+new"] }
    const result = toolResultMetadata("Bash", { bashEditDiff: { files: [
      null, { filePath: 42, hunks: [] },
      { filePath: "/a", hunks: [null, { ...good, oldStart: -1 }, { ...good, lines: [42] }, good] },
    ], moreFiles: "2" } })
    expect(result).toEqual({ fileDiffs: [{ filePath: "/a", hunks: [good] }] })
    expect(formatToolFileDiff(result.fileDiffs![0])).toBe("@@ -15,1 +15,1 @@\n-old\n+new")
  })

  it.each([null, undefined, "text", [], { bashEditDiff: null }])("accepts older or absent metadata: %j", (value) => {
    expect(toolResultMetadata("Bash", value)).toEqual({})
  })
})


describe("toolDiffEdits", () => {
  it.each([
    { name: "repeated edits", lines: [["-old", "+new"], ["-old", "+new"]], oldString: "old\nold\n", newString: "new\nnew\n", add: 2, del: 2 },
    { name: "opposing edits", lines: [["-old", "+new"], ["-new", "+old"]], oldString: "old\nnew\n", newString: "new\nold\n", add: 2, del: 2 },
    { name: "separate deletion and insertion of the same text", lines: [["-same"], ["+same"]], oldString: "same\n", newString: "same\n", add: 1, del: 1 },
    { name: "blank insertion", lines: [["+"]], oldString: "", newString: "\n", add: 1, del: 0 },
    { name: "blank deletion", lines: [["-"]], oldString: "\n", newString: "", add: 0, del: 1 },
  ])("keeps $name within one file result", ({ lines, oldString, newString, add, del }) => {
    const edits = toolDiffEdits([{ filePath: "/a", hunks: lines.map((lines, index) => ({
      oldStart: 1 + index * 10,
      oldLines: lines.filter(line => line.startsWith("-")).length,
      newStart: 1 + index * 10,
      newLines: lines.filter(line => line.startsWith("+")).length,
      lines,
    })) }])
    expect(edits).toEqual([{ filePath: "/a", oldString, newString, diffLineCounts: { add, del } }])
    expect(computeNetDiff(edits.map(edit => ({ ...edit, isWrite: false })))).toEqual({
      originalStr: oldString, currentStr: newString, addCount: add, delCount: del,
    })
  })

  it.each([
    { lines: ["-old", "\\ No newline at end of file", "+new"], oldString: "old", newString: "new\n" },
    { lines: ["-old", "+new", "\\ No newline at end of file"], oldString: "old\n", newString: "new" },
    { lines: ["-old", "\\ No newline at end of file", "+new", "\\ No newline at end of file"], oldString: "old", newString: "new" },
    { lines: ["-old", "+new", " context", "\\ No newline at end of file"], oldString: "old\ncontext", newString: "new\ncontext" },
  ])("preserves the no-newline marker on its own side: $lines", ({ lines, oldString, newString }) => {
    const edits = toolDiffEdits([{ filePath: "/a", hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines }] }])
    expect(edits[0]).toMatchObject({ oldString, newString, diffLineCounts: { add: 1, del: 1 } })
  })
})
