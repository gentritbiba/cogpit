import { act, render } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { StreamingOverlayProvider, useMainThreadOverlay, useToolUseOverlay } from "@/contexts/StreamingOverlayContext"
import { applyDeltas, EMPTY_OVERLAY, type StreamDeltaEvent } from "@/lib/streamingOverlay"
import { createStreamingOverlayStore } from "@/lib/streamingOverlayStore"

function delta(messageId: string, parentToolUseId: string | null, text: string): StreamDeltaEvent {
  return { messageId, parentToolUseId, blockIndex: 0, blockType: "text", delta: text }
}

describe("overlay selectors", () => {
  it("re-render a reader only when its own stream changes", () => {
    const store = createStreamingOverlayStore()
    const renders = { a: 0, b: 0, main: 0 }
    const seen: Record<string, string> = {}
    function ToolReader({ id }: { id: "a" | "b" }) {
      const messages = useToolUseOverlay(`toolu_${id}`)
      renders[id]++
      seen[id] = messages.map((m) => m.blocks.map((b) => b.text).join("")).join("|")
      return null
    }
    function MainReader() {
      useMainThreadOverlay()
      renders.main++
      return null
    }
    render(
      <StreamingOverlayProvider store={store}>
        <ToolReader id="a" />
        <ToolReader id="b" />
        <MainReader />
      </StreamingOverlayProvider>,
    )
    const initial = { ...renders }

    act(() => store.publish(applyDeltas(EMPTY_OVERLAY, [delta("msg_a", "toolu_a", "one")])))
    expect(renders.a).toBe(initial.a + 1)
    expect(renders.b).toBe(initial.b)
    expect(renders.main).toBe(initial.main)

    act(() => store.publish(applyDeltas(store.snapshot(), [delta("msg_b", "toolu_b", "two")])))
    expect(renders.a).toBe(initial.a + 1)
    expect(renders.b).toBe(initial.b + 1)

    act(() => store.publish(applyDeltas(store.snapshot(), [delta("msg_a", "toolu_a", " more")])))
    expect(seen.a).toBe("one more")
    expect(seen.b).toBe("two")
    expect(renders.b).toBe(initial.b + 1)
    expect(renders.main).toBe(initial.main)
  })
})
