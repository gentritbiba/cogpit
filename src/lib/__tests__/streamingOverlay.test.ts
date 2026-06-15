import { describe, it, expect } from "vitest"
import {
  applySnapshot,
  applyDeltas,
  reconcileWithLines,
  sweepStale,
  mainThreadMessages,
  messagesForToolUse,
  EMPTY_OVERLAY,
  type StreamDeltaEvent,
  type StreamingOverlay,
} from "@/lib/streamingOverlay"

function delta(overrides: Partial<StreamDeltaEvent> = {}): StreamDeltaEvent {
  return {
    messageId: "msg_1",
    parentToolUseId: null,
    blockIndex: 0,
    blockType: "text",
    delta: "",
    ...overrides,
  }
}

describe("applyDeltas", () => {
  it("creates messages and accumulates block text in order", () => {
    let overlay: StreamingOverlay = EMPTY_OVERLAY
    overlay = applyDeltas(overlay, [
      delta({ event: "block_start" }),
      delta({ delta: "Hello " }),
      delta({ delta: "world" }),
    ])

    expect(overlay).toHaveLength(1)
    expect(overlay[0].blocks).toHaveLength(1)
    expect(overlay[0].blocks[0].text).toBe("Hello world")
    expect(overlay[0].stopped).toBe(false)
  })

  it("returns a new array identity on change", () => {
    const before: StreamingOverlay = EMPTY_OVERLAY
    const after = applyDeltas(before, [delta({ delta: "x" })])
    expect(after).not.toBe(before)
  })

  it("returns the same reference for an empty batch", () => {
    const overlay = applyDeltas(EMPTY_OVERLAY, [delta({ delta: "x" })])
    expect(applyDeltas(overlay, [])).toBe(overlay)
  })

  it("tracks multiple blocks per message (thinking then text)", () => {
    const overlay = applyDeltas(EMPTY_OVERLAY, [
      delta({ blockIndex: 0, blockType: "thinking", event: "block_start" }),
      delta({ blockIndex: 0, blockType: "thinking", delta: "pondering…" }),
      delta({ blockIndex: 1, blockType: "text", event: "block_start" }),
      delta({ blockIndex: 1, blockType: "text", delta: "answer" }),
    ])

    expect(overlay[0].blocks.map((b) => b.blockType)).toEqual(["thinking", "text"])
    expect(overlay[0].blocks[0].text).toBe("pondering…")
    expect(overlay[0].blocks[1].text).toBe("answer")
  })

  it("keeps tool_use blocks with their tool name", () => {
    const overlay = applyDeltas(EMPTY_OVERLAY, [
      delta({ blockIndex: 2, blockType: "tool_use", toolName: "Bash", event: "block_start" }),
    ])
    expect(overlay[0].blocks[0].toolName).toBe("Bash")
  })

  it("tracks concurrent main-thread and subagent messages (lanes)", () => {
    const overlay = applyDeltas(EMPTY_OVERLAY, [
      delta({ messageId: "msg_main", delta: "main" }),
      delta({ messageId: "msg_sub", parentToolUseId: "toolu_1", delta: "sub" }),
    ])

    expect(mainThreadMessages(overlay).map((m) => m.messageId)).toEqual(["msg_main"])
    expect(messagesForToolUse(overlay, "toolu_1").map((m) => m.messageId)).toEqual(["msg_sub"])
  })

  it("message_stop marks the message stopped with a timestamp", () => {
    const overlay = applyDeltas(EMPTY_OVERLAY, [
      delta({ delta: "done" }),
      delta({ event: "message_stop", blockIndex: -1 }),
    ])
    expect(overlay[0].stopped).toBe(true)
    expect(overlay[0].stoppedAt).toBeTypeOf("number")
  })

  it("does not mutate the previous overlay", () => {
    const first = applyDeltas(EMPTY_OVERLAY, [delta({ delta: "abc" })])
    const snapshotText = first[0].blocks[0].text
    applyDeltas(first, [delta({ delta: "def" })])
    expect(first[0].blocks[0].text).toBe(snapshotText)
  })
})

describe("applySnapshot", () => {
  it("replaces the overlay from server state", () => {
    const overlay = applySnapshot([
      {
        messageId: "msg_s",
        parentToolUseId: null,
        stopped: false,
        blocks: [{ index: 0, blockType: "text", text: "mid-flight" }],
      },
    ])
    expect(overlay[0].blocks[0].text).toBe("mid-flight")
  })

  it("stamps stoppedAt for already-stopped messages so they can be swept", () => {
    const overlay = applySnapshot([
      { messageId: "msg_s", parentToolUseId: null, stopped: true, blocks: [] },
    ])
    expect(overlay[0].stoppedAt).toBeTypeOf("number")
  })
})

describe("reconcileWithLines", () => {
  const overlay = applyDeltas(EMPTY_OVERLAY, [
    delta({ messageId: "msg_landed", delta: "a" }),
    delta({ messageId: "msg_pending", delta: "b" }),
  ])

  it("drops messages whose id appears in an incoming JSONL line", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { id: "msg_landed", role: "assistant", content: [{ type: "text", text: "a" }] },
    })
    const next = reconcileWithLines(overlay, [line])
    expect(next.map((m) => m.messageId)).toEqual(["msg_pending"])
  })

  it("matches ids inside synthesized agent_progress lines", () => {
    const line = JSON.stringify({
      type: "progress",
      data: { type: "agent_progress", message: { message: { id: "msg_landed" } } },
    })
    const next = reconcileWithLines(overlay, [line])
    expect(next.map((m) => m.messageId)).toEqual(["msg_pending"])
  })

  it("returns the same reference when nothing matches", () => {
    const huge = JSON.stringify({ type: "user", message: { content: "x".repeat(100_000) } })
    expect(reconcileWithLines(overlay, [huge])).toBe(overlay)
  })

  it("returns the same reference for empty inputs", () => {
    expect(reconcileWithLines(EMPTY_OVERLAY, ["line"])).toBe(EMPTY_OVERLAY)
    expect(reconcileWithLines(overlay, [])).toBe(overlay)
  })

  it("does NOT reconcile subagent messages — they persist as the live transcript", () => {
    const withSub = applyDeltas(EMPTY_OVERLAY, [
      delta({ messageId: "msg_sub", parentToolUseId: "toolu_1", delta: "agent text" }),
    ])
    const line = JSON.stringify({
      type: "progress",
      data: { type: "agent_progress", message: { message: { id: "msg_sub" } } },
    })
    expect(reconcileWithLines(withSub, [line])).toBe(withSub)
  })
})

describe("sweepStale", () => {
  it("drops stopped messages older than maxAgeMs", () => {
    const now = Date.now()
    const overlay: StreamingOverlay = [
      { messageId: "msg_old", parentToolUseId: null, stopped: true, stoppedAt: now - 20_000, blocks: [] },
      { messageId: "msg_fresh", parentToolUseId: null, stopped: true, stoppedAt: now - 1_000, blocks: [] },
      { messageId: "msg_live", parentToolUseId: null, stopped: false, blocks: [] },
    ]
    const next = sweepStale(overlay, 10_000, now)
    expect(next.map((m) => m.messageId)).toEqual(["msg_fresh", "msg_live"])
  })

  it("returns the same reference when nothing is stale", () => {
    const overlay: StreamingOverlay = [
      { messageId: "msg_live", parentToolUseId: null, stopped: false, blocks: [] },
    ]
    expect(sweepStale(overlay)).toBe(overlay)
  })

  it("never sweeps subagent messages — stream_clear handles them at turn end", () => {
    const now = Date.now()
    const overlay: StreamingOverlay = [
      { messageId: "msg_sub", parentToolUseId: "toolu_1", stopped: true, stoppedAt: now - 60_000, blocks: [] },
    ]
    expect(sweepStale(overlay, 10_000, now)).toBe(overlay)
  })
})
