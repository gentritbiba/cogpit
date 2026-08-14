import { render, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { StreamingOverlayProvider } from "@/contexts/StreamingOverlayContext"
import type { StreamingOverlay } from "@/lib/streamingOverlay"
import { StreamingTurnOverlay } from "../StreamingTurnOverlay"

function renderOverlay(text: string) {
  const overlay: StreamingOverlay = [
    {
      messageId: "msg_streaming",
      parentToolUseId: null,
      stopped: false,
      blocks: [{ index: 0, blockType: "text", text }],
    },
  ]

  return render(
    <StreamingOverlayProvider value={overlay}>
      <StreamingTurnOverlay />
    </StreamingOverlayProvider>,
  )
}

describe("StreamingTurnOverlay", () => {
  it("renders markdown before the streamed message is complete", () => {
    renderOverlay("## Live result\n\n- **first item**\n- `second item`")

    const liveOutput = screen.getByTestId("streaming-turn-overlay")
    expect(within(liveOutput).getByRole("heading", { name: "Live result" })).toBeInTheDocument()
    expect(within(liveOutput).getAllByRole("listitem")).toHaveLength(2)
    expect(liveOutput.querySelector("strong")?.textContent).toBe("first item")
    expect(liveOutput.querySelector("code")?.textContent).toBe("second item")
    expect(liveOutput.textContent).not.toContain("**")
    expect(liveOutput.textContent).not.toContain("##")
  })

  it("uses lightweight code rendering for an unfinished fence", () => {
    renderOverlay("Working on it:\n\n```ts\nconst answer = 42")

    const liveOutput = screen.getByTestId("streaming-turn-overlay")
    const pre = liveOutput.querySelector("pre")
    expect(pre?.textContent).toContain("const answer = 42")
    expect(within(liveOutput).queryByRole("button")).toBeNull()
    expect(pre?.className).toContain("overflow-x-auto")
  })
})
