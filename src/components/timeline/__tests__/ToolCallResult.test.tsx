import { render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { getLangFromPath, highlightCode } = vi.hoisted(() => ({
  getLangFromPath: vi.fn(() => "typescript"),
  highlightCode: vi.fn(),
}))

vi.mock("@/hooks/useIsDarkMode", () => ({ useIsDarkMode: () => true }))
vi.mock("@/lib/shiki", () => ({ getLangFromPath, highlightCode }))

import {
  JsonResultHighlighted,
  ReadResultHighlighted,
  tryPrettyJson,
  previewToolResult,
} from "../ToolCallResult"

describe("tryPrettyJson", () => {
  it("pretty-prints JSON objects and arrays", () => {
    expect(tryPrettyJson('{"ok":true}')).toBe('{\n  "ok": true\n}')
    expect(tryPrettyJson("[1,2]")).toBe("[\n  1,\n  2\n]")
  })

  it("rejects plain text and malformed JSON", () => {
    expect(tryPrettyJson("hello")).toBeNull()
    expect(tryPrettyJson("{not-json}")).toBeNull()
  })
})

describe("highlighted tool results", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    highlightCode.mockResolvedValue([])
  })

  it("parses Read line prefixes and selects syntax from the file path", async () => {
    render(
      <ReadResultHighlighted
        result={"  7→const value = 1\nplain line"}
        filePath="/tmp/example.ts"
      />,
    )

    expect(screen.getByText("7")).toBeInTheDocument()
    expect(screen.getByText("const value = 1")).toBeInTheDocument()
    expect(screen.getByText("plain line")).toBeInTheDocument()
    expect(getLangFromPath).toHaveBeenCalledWith("/tmp/example.ts")
    await waitFor(() => {
      expect(highlightCode).toHaveBeenCalledWith(
        "const value = 1\nplain line",
        "typescript",
        true,
      )
    })
  })

  it("pretty-prints JSON before highlighting it", async () => {
    render(<JsonResultHighlighted result={'{"status":"ok"}'} />)

    await waitFor(() => {
      expect(highlightCode).toHaveBeenCalledWith(
        '{\n  "status": "ok"\n}',
        "json",
        true,
      )
    })
    expect(screen.getByText(/"status": "ok"/)).toBeInTheDocument()
  })

  it("renders highlighted token content when available", async () => {
    highlightCode.mockResolvedValue([
      [{ content: "const", color: "#ff0000" }, { content: " value", color: "#00ff00" }],
    ])

    render(
      <ReadResultHighlighted
        result="const value"
        filePath="/tmp/example.ts"
      />,
    )

    expect(await screen.findByText("const")).toHaveStyle({ color: "rgb(255, 0, 0)" })
    expect(screen.getByText("value")).toHaveStyle({ color: "rgb(0, 255, 0)" })
  })
})


describe("tool result preview", () => {
  it("bounds a single line without losing the expansion affordance", () => {
    const preview = previewToolResult("a".repeat(1001))
    expect(preview).toEqual({ text: "a".repeat(1000), hiddenLines: 0, truncated: true })
  })

  it("counts logical lines across platform newline formats", () => {
    const result = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\r\n")
    const preview = previewToolResult(result)
    expect(preview.text.split("\n")).toHaveLength(8)
    expect(preview.hiddenLines).toBe(2)
    expect(preview.truncated).toBe(true)
  })

  it("applies the character bound even when there are many lines", () => {
    const preview = previewToolResult(`${"x".repeat(1200)}\n${Array(10).fill("next").join("\n")}`)
    expect(preview.text).toHaveLength(1000)
    expect(preview.hiddenLines).toBe(10)
    expect(preview.truncated).toBe(true)
  })

  it("does not shorten exactly eight short lines", () => {
    const result = Array(8).fill("line").join("\n")
    expect(previewToolResult(result)).toEqual({ text: result, hiddenLines: 0, truncated: false })
  })
})

describe("highlight updates", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    highlightCode.mockResolvedValue([])
  })

  it("shows new text immediately while replacement tokens are loading", async () => {
    highlightCode.mockResolvedValueOnce([[{ content: "before", color: "#ff0000" }]])
    const { rerender } = render(<ReadResultHighlighted result="before" filePath="example.ts" />)
    await waitFor(() => expect(screen.getByText("before")).toHaveStyle({ color: "rgb(255, 0, 0)" }))
    highlightCode.mockReturnValueOnce(new Promise(() => {}))
    rerender(<ReadResultHighlighted result="after" filePath="example.ts" />)
    expect(screen.getByText("after")).toBeTruthy()
    expect(screen.queryByText("before")).toBeNull()
  })

  it("keeps plain text when syntax highlighting rejects", async () => {
    highlightCode.mockRejectedValueOnce(new Error("Grammar unavailable"))
    render(<ReadResultHighlighted result="readable source" filePath="example.ts" />)
    await waitFor(() => expect(highlightCode).toHaveBeenCalled())
    expect(screen.getByText("readable source")).toBeTruthy()
  })
})
