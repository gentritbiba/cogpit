// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  publish,
  completeMessage,
  clear,
  getSnapshot,
  subscribe,
  _resetForTests,
  type StreamBusEvent,
  type StreamDelta,
} from "../../lib/streamBus"

const SID = "session-1"

function messageStart(id: string) {
  return { type: "message_start", message: { id } }
}
function blockStart(index: number, type = "text", name?: string) {
  return { type: "content_block_start", index, content_block: { type, ...(name ? { name } : {}) } }
}
function textDelta(index: number, text: string) {
  return { type: "content_block_delta", index, delta: { type: "text_delta", text } }
}
function thinkingDelta(index: number, thinking: string) {
  return { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking } }
}
function messageStop() {
  return { type: "message_stop" }
}

function collect(): { events: StreamBusEvent[]; unsubscribe: () => void } {
  const events: StreamBusEvent[] = []
  const unsubscribe = subscribe(SID, (ev) => events.push(ev))
  return { events, unsubscribe }
}

function deltasOf(events: StreamBusEvent[]): StreamDelta[] {
  return events.flatMap((ev) => (ev.type === "stream_delta" ? ev.events : []))
}

beforeEach(() => {
  vi.useFakeTimers()
  _resetForTests()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("streamBus", () => {
  it("accumulates text per block and exposes it via snapshot", () => {
    publish(SID, messageStart("msg_1"), null)
    publish(SID, blockStart(0), null)
    publish(SID, textDelta(0, "Hello "), null)
    publish(SID, textDelta(0, "world"), null)

    const snapshot = getSnapshot(SID)
    expect(snapshot).toHaveLength(1)
    expect(snapshot![0].messageId).toBe("msg_1")
    expect(snapshot![0].blocks).toEqual([
      { index: 0, blockType: "text", text: "Hello world" },
    ])
  })

  it("tracks lanes independently: main thread and subagent stream concurrently", () => {
    publish(SID, messageStart("msg_main"), null)
    publish(SID, messageStart("msg_sub"), "toolu_1")
    publish(SID, blockStart(0), null)
    publish(SID, blockStart(0), "toolu_1")
    publish(SID, textDelta(0, "main text"), null)
    publish(SID, textDelta(0, "sub text"), "toolu_1")

    const snapshot = getSnapshot(SID)!
    const main = snapshot.find((m) => m.messageId === "msg_main")!
    const sub = snapshot.find((m) => m.messageId === "msg_sub")!
    expect(main.parentToolUseId).toBeNull()
    expect(main.blocks[0].text).toBe("main text")
    expect(sub.parentToolUseId).toBe("toolu_1")
    expect(sub.blocks[0].text).toBe("sub text")
  })

  it("leading flush fires immediately, the rest batch per window", () => {
    const { events } = collect()
    publish(SID, messageStart("msg_1"), null)
    publish(SID, blockStart(0), null)
    publish(SID, textDelta(0, "a"), null)
    publish(SID, textDelta(0, "b"), null)
    publish(SID, textDelta(0, "c"), null)

    // Leading flush carried block_start (the first queued delta)
    expect(events.length).toBe(1)

    vi.advanceTimersByTime(80)
    // Trailing flush delivers the batched text
    expect(events.length).toBe(2)
    const allText = deltasOf(events)
      .filter((d) => !d.event)
      .map((d) => d.delta)
      .join("")
    expect(allText).toBe("abc")
  })

  it("merges consecutive deltas for the same block within a window", () => {
    const { events } = collect()
    publish(SID, messageStart("msg_1"), null)
    publish(SID, blockStart(0), null)
    for (const ch of "streaming") {
      publish(SID, textDelta(0, ch), null)
    }
    vi.advanceTimersByTime(80)

    const textDeltas = deltasOf(events).filter((d) => !d.event)
    expect(textDeltas).toHaveLength(1)
    expect(textDeltas[0].delta).toBe("streaming")
  })

  it("thinking and tool_use blocks carry their type and tool name", () => {
    const { events } = collect()
    publish(SID, messageStart("msg_1"), null)
    publish(SID, blockStart(0, "thinking"), null)
    publish(SID, thinkingDelta(0, "hmm"), null)
    publish(SID, blockStart(1, "tool_use", "Bash"), null)
    vi.advanceTimersByTime(80)

    const deltas = deltasOf(events)
    expect(deltas.find((d) => d.blockType === "thinking" && !d.event)?.delta).toBe("hmm")
    const toolStart = deltas.find((d) => d.blockType === "tool_use" && d.event === "block_start")
    expect(toolStart?.toolName).toBe("Bash")
  })

  it("message_stop marks the message stopped and frees the lane", () => {
    const { events } = collect()
    publish(SID, messageStart("msg_1"), null)
    publish(SID, blockStart(0), null)
    publish(SID, messageStop(), null)
    vi.advanceTimersByTime(80)

    expect(getSnapshot(SID)![0].stopped).toBe(true)
    expect(deltasOf(events).some((d) => d.event === "message_stop")).toBe(true)

    // Lane is free: a new message_start begins a fresh message
    publish(SID, messageStart("msg_2"), null)
    publish(SID, blockStart(0), null)
    publish(SID, textDelta(0, "next"), null)
    expect(getSnapshot(SID)!.find((m) => m.messageId === "msg_2")!.blocks[0].text).toBe("next")
  })

  it("completeMessage removes state so snapshots never duplicate the JSONL", () => {
    publish(SID, messageStart("msg_1"), null)
    publish(SID, blockStart(0), null)
    publish(SID, textDelta(0, "done text"), null)

    completeMessage(SID, "msg_1")
    expect(getSnapshot(SID)).toBeNull()
  })

  it("clear wipes state and emits stream_clear", () => {
    const { events } = collect()
    publish(SID, messageStart("msg_1"), null)
    publish(SID, blockStart(0), null)
    clear(SID)

    expect(getSnapshot(SID)).toBeNull()
    expect(events.some((ev) => ev.type === "stream_clear")).toBe(true)
  })

  it("accumulates without subscribers (no emit work) and serves a late snapshot", () => {
    publish(SID, messageStart("msg_1"), null)
    publish(SID, blockStart(0), null)
    publish(SID, textDelta(0, "early text"), null)
    vi.advanceTimersByTime(200)

    // Late subscriber gets nothing pushed retroactively…
    const { events } = collect()
    expect(events).toHaveLength(0)
    // …but the snapshot has the accumulated state
    expect(getSnapshot(SID)![0].blocks[0].text).toBe("early text")
  })

  it("caps in-flight messages per session", () => {
    for (let i = 0; i < 60; i++) {
      publish(SID, messageStart(`msg_${i}`), null)
      publish(SID, messageStop(), null)
    }
    expect(getSnapshot(SID)!.length).toBeLessThanOrEqual(50)
  })

  it("caps accumulated block text", () => {
    publish(SID, messageStart("msg_1"), null)
    publish(SID, blockStart(0), null)
    const chunk = "x".repeat(64 * 1024)
    for (let i = 0; i < 8; i++) {
      publish(SID, textDelta(0, chunk), null)
    }
    const len = getSnapshot(SID)![0].blocks[0].text.length
    expect(len).toBeLessThanOrEqual(256 * 1024 + chunk.length)
  })

  it("unsubscribe stops delivery", () => {
    const { events, unsubscribe } = collect()
    publish(SID, messageStart("msg_1"), null)
    publish(SID, blockStart(0), null)
    vi.advanceTimersByTime(80)
    const before = events.length

    unsubscribe()
    publish(SID, textDelta(0, "after"), null)
    vi.advanceTimersByTime(80)
    expect(events.length).toBe(before)
  })

  it("publishCompleteMessage surfaces a finished subagent message to subscribers", async () => {
    const { publishCompleteMessage } = await import("../../lib/streamBus")
    const { events } = collect()

    publishCompleteMessage(SID, {
      messageId: "msg_sub",
      parentToolUseId: "toolu_9",
      blocks: [
        { blockType: "thinking", text: "hmm" },
        { blockType: "text", text: "found it" },
      ],
    })
    vi.advanceTimersByTime(80)

    const snapshot = getSnapshot(SID)!
    expect(snapshot[0].parentToolUseId).toBe("toolu_9")
    expect(snapshot[0].stopped).toBe(true)
    expect(snapshot[0].blocks.map((b) => b.text)).toEqual(["hmm", "found it"])

    const deltas = deltasOf(events)
    expect(deltas.some((d) => d.delta === "found it" && d.parentToolUseId === "toolu_9")).toBe(true)
    expect(deltas.some((d) => d.event === "message_stop")).toBe(true)
  })

  it("infers block type for deltas without a preceding block_start", () => {
    publish(SID, messageStart("msg_1"), null)
    publish(SID, thinkingDelta(2, "orphan thinking"), null)
    const block = getSnapshot(SID)![0].blocks[0]
    expect(block.blockType).toBe("thinking")
    expect(block.text).toBe("orphan thinking")
  })
})
