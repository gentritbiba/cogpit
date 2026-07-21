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
        expanded
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
    render(<JsonResultHighlighted result={'{"status":"ok"}'} expanded />)

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
        expanded
      />,
    )

    expect(await screen.findByText("const")).toHaveStyle({ color: "rgb(255, 0, 0)" })
    expect(screen.getByText("value")).toHaveStyle({ color: "rgb(0, 255, 0)" })
  })
})
