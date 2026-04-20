import { describe, it, expect } from "vitest"
import { applyStreamEvent, dropByMessageIds } from "@/lib/partialMessages"
import type { PartialAssistantMessage, StreamEventSSE } from "@/lib/types"

const evt = (event: StreamEventSSE["event"]): StreamEventSSE => ({
  type: "stream_event",
  event,
  parent_tool_use_id: null,
})

describe("applyStreamEvent", () => {
  it("message_start creates an empty partial", () => {
    const next = applyStreamEvent(
      new Map(),
      evt({ type: "message_start", message: { id: "msg_1" } }),
    )
    expect(next.has("msg_1")).toBe(true)
    expect(next.get("msg_1")!.stopped).toBe(false)
    expect(next.get("msg_1")!.blocks.size).toBe(0)
  })

  it("content_block_start creates an empty text block at index", () => {
    let m = new Map<string, PartialAssistantMessage>()
    m = applyStreamEvent(m, evt({ type: "message_start", message: { id: "m1" } }))
    m = applyStreamEvent(
      m,
      evt({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
    )
    expect(m.get("m1")!.blocks.get(0)).toEqual({ type: "text", text: "" })
  })

  it("text_delta appends to the current block", () => {
    let m = new Map<string, PartialAssistantMessage>()
    m = applyStreamEvent(m, evt({ type: "message_start", message: { id: "m2" } }))
    m = applyStreamEvent(
      m,
      evt({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
    )
    m = applyStreamEvent(
      m,
      evt({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hel" },
      }),
    )
    m = applyStreamEvent(
      m,
      evt({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "lo" },
      }),
    )
    expect(m.get("m2")!.blocks.get(0)).toEqual({ type: "text", text: "Hello" })
  })

  it("thinking_delta appends to thinking block", () => {
    let m = new Map<string, PartialAssistantMessage>()
    m = applyStreamEvent(m, evt({ type: "message_start", message: { id: "m3" } }))
    m = applyStreamEvent(
      m,
      evt({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      }),
    )
    m = applyStreamEvent(
      m,
      evt({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "reasoning..." },
      }),
    )
    expect(m.get("m3")!.blocks.get(0)).toEqual({
      type: "thinking",
      text: "reasoning...",
    })
  })

  it("input_json_delta appends to tool_use partial input", () => {
    let m = new Map<string, PartialAssistantMessage>()
    m = applyStreamEvent(m, evt({ type: "message_start", message: { id: "m4" } }))
    m = applyStreamEvent(
      m,
      evt({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "t1", name: "Read" },
      }),
    )
    m = applyStreamEvent(
      m,
      evt({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"file"' },
      }),
    )
    m = applyStreamEvent(
      m,
      evt({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: ':"x"}' },
      }),
    )
    expect(m.get("m4")!.blocks.get(0)).toEqual({
      type: "tool_use",
      id: "t1",
      name: "Read",
      partialInputJson: '{"file":"x"}',
    })
  })

  it("message_stop marks the most recently opened partial as stopped", () => {
    let m = new Map<string, PartialAssistantMessage>()
    m = applyStreamEvent(m, evt({ type: "message_start", message: { id: "m5" } }))
    m = applyStreamEvent(m, evt({ type: "message_stop" }))
    expect(m.get("m5")!.stopped).toBe(true)
  })

  it("is a no-op for unknown event types (returns same reference)", () => {
    const m = new Map<string, PartialAssistantMessage>()
    const next = applyStreamEvent(
      m,
      evt({ type: "message_delta" as StreamEventSSE["event"]["type"] }),
    )
    expect(next).toBe(m)
  })
})

describe("dropByMessageIds", () => {
  it("removes the given ids from the map", () => {
    const m = new Map<string, PartialAssistantMessage>([
      ["a", { messageId: "a", blocks: new Map(), stopped: true }],
      ["b", { messageId: "b", blocks: new Map(), stopped: false }],
    ])
    const next = dropByMessageIds(m, new Set(["a"]))
    expect(next.has("a")).toBe(false)
    expect(next.has("b")).toBe(true)
  })

  it("returns the same reference when nothing is dropped", () => {
    const m = new Map<string, PartialAssistantMessage>([
      ["a", { messageId: "a", blocks: new Map(), stopped: true }],
    ])
    expect(dropByMessageIds(m, new Set(["nope"]))).toBe(m)
  })
})
