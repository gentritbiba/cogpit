import { describe, expect, it } from "vitest"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { StreamingOverlayProvider } from "@/contexts/StreamingOverlayContext"
import type { StreamingOverlay } from "@/lib/streamingOverlay"
import { LiveSubagentTranscript } from "../LiveSubagentTranscript"

const TOOL_ID = "toolu_live"

/** Stubbed pane geometry: a 256px viewport over 1000px of content. */
const SCROLL_HEIGHT = 1000
const CLIENT_HEIGHT = 256
const BOTTOM = SCROLL_HEIGHT - CLIENT_HEIGHT

function overlayWith(text: string, parentToolUseId: string | null = TOOL_ID): StreamingOverlay {
  return [
    {
      messageId: "msg_1",
      parentToolUseId,
      stopped: false,
      blocks: [{ index: 0, blockType: "text", text }],
    },
  ]
}

function tree(overlay: StreamingOverlay) {
  return (
    <StreamingOverlayProvider value={overlay}>
      <LiveSubagentTranscript toolUseId={TOOL_ID} />
    </StreamingOverlayProvider>
  )
}

function renderTranscript(overlay: StreamingOverlay) {
  return render(tree(overlay))
}

/** jsdom reports 0 for every scroll metric; the pane's follow logic needs real ones. */
function stubScrollMetrics(el: HTMLElement) {
  Object.defineProperty(el, "scrollHeight", { value: SCROLL_HEIGHT, configurable: true })
  Object.defineProperty(el, "clientHeight", { value: CLIENT_HEIGHT, configurable: true })
}

const longOutput = Array.from({ length: 450 }, (_, i) => `line ${i + 1}`).join("\n")

describe("LiveSubagentTranscript", () => {
  it("renders nothing when the overlay has no messages for this tool", () => {
    renderTranscript(overlayWith("streamed text", "some_other_tool"))
    expect(screen.queryByTestId("live-subagent-transcript")).toBeNull()
  })

  it("renders markdown instead of raw source", () => {
    renderTranscript(overlayWith("## Deliberately left alone\n\n- **bold item**\n- `readRange` call"))

    const pane = screen.getByTestId("live-subagent-transcript")
    expect(within(pane).getByRole("heading", { name: "Deliberately left alone" })).toBeInTheDocument()
    expect(within(pane).getAllByRole("listitem")).toHaveLength(2)
    expect(pane.querySelector("strong")?.textContent).toBe("bold item")
    expect(pane.querySelector("code")?.textContent).toBe("readRange")
    expect(pane.textContent).not.toContain("**")
    expect(pane.textContent).not.toContain("##")
  })

  it("renders an unterminated code fence as plain code, bypassing the Shiki block", () => {
    renderTranscript(overlayWith("Here goes:\n\n```ts\nconst x = 1\nconst y = 2"))

    const pane = screen.getByTestId("live-subagent-transcript")
    const pre = pane.querySelector("pre")
    expect(pre?.textContent).toContain("const x = 1")
    // The shared MarkdownCodeBlock ships a copy button and a line-number gutter;
    // the live pane's plain <pre> has neither.
    expect(within(pane).queryByRole("button")).toBeNull()
    expect(pre?.className).toContain("overflow-x-auto")
  })

  it("drops images, whose paths are often still mid-stream", () => {
    renderTranscript(overlayWith("progress\n\n![shot](/tmp/screenshot.png)"))

    const pane = screen.getByTestId("live-subagent-transcript")
    expect(pane.querySelector("img")).toBeNull()
    expect(pane.textContent).toContain("progress")
  })

  it("is a bounded, focusable scroll container rather than a clipped box", () => {
    renderTranscript(overlayWith("some output"))

    const scroller = screen.getByTestId("live-subagent-scroll")
    expect(scroller.className).toContain("overflow-y-auto")
    expect(scroller.className).toContain("max-h-64")
    // Chaining wheel events into the chat scroller would break its own auto-follow.
    expect(scroller.className).toContain("overscroll-contain")
    expect(scroller.className).not.toContain("overflow-hidden")
    // Keyboard users must be able to reach a scrollable region.
    expect(scroller.tabIndex).toBe(0)
  })

  it("keeps only the tail once output exceeds the line cap, and flags the trim", () => {
    renderTranscript(overlayWith(longOutput))

    const pane = screen.getByTestId("live-subagent-transcript")
    expect(pane.textContent).toContain("line 450")
    expect(pane.textContent).not.toContain("line 1\n")
    expect(pane.textContent).toContain("…")
  })

  it("stops trimming while the reader is scrolled up, so text cannot slide out from under them", () => {
    const { rerender } = renderTranscript(overlayWith(longOutput))
    const scroller = screen.getByTestId("live-subagent-scroll")
    stubScrollMetrics(scroller)

    scroller.scrollTop = 0
    fireEvent.scroll(scroller)

    rerender(tree(overlayWith(`${longOutput}\nline 451`)))

    const pane = screen.getByTestId("live-subagent-transcript")
    expect(pane.textContent).toContain("line 1\n")
    expect(pane.textContent).not.toContain("…")
  })

  it("follows new output while pinned to the bottom", () => {
    const { rerender } = renderTranscript(overlayWith("first chunk"))
    const scroller = screen.getByTestId("live-subagent-scroll")
    stubScrollMetrics(scroller)

    rerender(tree(overlayWith("first chunk\nsecond chunk")))

    expect(scroller.scrollTop).toBe(BOTTOM)
  })

  it("stops following after the reader scrolls up, and resumes at the bottom", () => {
    const { rerender } = renderTranscript(overlayWith("first chunk"))
    const scroller = screen.getByTestId("live-subagent-scroll")
    stubScrollMetrics(scroller)

    scroller.scrollTop = 0
    fireEvent.scroll(scroller)

    rerender(tree(overlayWith("first chunk\nsecond chunk")))
    expect(scroller.scrollTop).toBe(0)

    // Back within the follow threshold — the pane re-pins itself.
    scroller.scrollTop = BOTTOM - 10
    fireEvent.scroll(scroller)
    expect(scroller.scrollTop).toBe(BOTTOM)
  })
})
