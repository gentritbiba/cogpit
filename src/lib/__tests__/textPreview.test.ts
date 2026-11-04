import { describe, expect, it } from "vitest"
import { previewLine } from "../textPreview"

describe("previewLine", () => {
  it("reads the first line as plain text, without markdown", () => {
    expect(previewLine("## Summary\nEverything passed.")).toBe("Summary")
    expect(previewLine("**Fixed** the `parser` and ~~broke~~ nothing")).toBe("Fixed the parser and broke nothing")
    expect(previewLine("See [the PR](https://example.test/pr/1) and ![shot](/tmp/a.png)")).toBe("See the PR and shot")
  })

  it("drops list and quote markers", () => {
    expect(previewLine("- first item\n- second")).toBe("first item")
    expect(previewLine("1. step one")).toBe("step one")
    expect(previewLine("> quoted reply")).toBe("quoted reply")
  })

  it("skips lines that are only markup", () => {
    expect(previewLine("\n---\n\n```ts\nconst answer = 42\n```")).toBe("const answer = 42")
    expect(previewLine("===\nReal text")).toBe("Real text")
  })

  it("reads a table row as its cells", () => {
    expect(previewLine("| File | Status |\n| --- | --- |\n| a.ts | ok |")).toBe("File · Status")
  })

  it("bounds a long line with an ellipsis", () => {
    const line = previewLine("word ".repeat(100), 20)
    expect(line).toHaveLength(20)
    expect(line.endsWith("…")).toBe(true)
  })

  it("is empty when nothing is worth reading", () => {
    expect(previewLine("")).toBe("")
    expect(previewLine("\n\n---\n")).toBe("")
  })
})
