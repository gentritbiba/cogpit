import { describe, it, expect } from "vitest"
import {
  applyStreamEvent,
  dropByMessageIds,
  synthesizePartialTurns,
} from "@/lib/partialMessages"
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

  it("returns same reference when delta arrives before its block_start", () => {
    let m = new Map<string, PartialAssistantMessage>()
    m = applyStreamEvent(m, evt({ type: "message_start", message: { id: "m6" } }))
    const before = m
    const next = applyStreamEvent(
      m,
      evt({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "oops" },
      }),
    )
    expect(next).toBe(before)
  })

  it("returns same reference on block/delta type mismatch", () => {
    let m = new Map<string, PartialAssistantMessage>()
    m = applyStreamEvent(m, evt({ type: "message_start", message: { id: "m7" } }))
    m = applyStreamEvent(
      m,
      evt({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
    )
    const before = m
    const next = applyStreamEvent(
      m,
      evt({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "wat" },
      }),
    )
    expect(next).toBe(before)
  })

  it("returns same reference when text_delta is empty", () => {
    let m = new Map<string, PartialAssistantMessage>()
    m = applyStreamEvent(m, evt({ type: "message_start", message: { id: "m8" } }))
    m = applyStreamEvent(
      m,
      evt({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
    )
    const before = m
    const next = applyStreamEvent(
      m,
      evt({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "" },
      }),
    )
    expect(next).toBe(before)
  })
})

describe("synthesizePartialTurns", () => {
  it("returns an empty array when the partials map is empty", () => {
    const out = synthesizePartialTurns(new Map(), new Set())
    expect(out).toEqual([])
  })

  it("skips partials whose messageId is already in existingAssistantIds", () => {
    const partials = new Map<string, PartialAssistantMessage>([
      [
        "msg_a",
        {
          messageId: "msg_a",
          blocks: new Map([[0, { type: "text", text: "hello" }]]),
          stopped: false,
        },
      ],
      [
        "msg_b",
        {
          messageId: "msg_b",
          blocks: new Map([[0, { type: "text", text: "world" }]]),
          stopped: false,
        },
      ],
    ])
    const out = synthesizePartialTurns(partials, new Set(["msg_a"]))
    expect(out).toHaveLength(1)
    expect(out[0].messageId).toBe("msg_b")
  })

  it("emits a renderable turn for new partial messageIds in insertion order", () => {
    const partials = new Map<string, PartialAssistantMessage>()
    partials.set("msg_1", {
      messageId: "msg_1",
      blocks: new Map<number, { type: "text"; text: string } | { type: "thinking"; text: string } | { type: "tool_use"; id: string; name: string; partialInputJson: string }>([
        [0, { type: "text", text: "first" }],
      ]),
      stopped: false,
    })
    partials.set("msg_2", {
      messageId: "msg_2",
      blocks: new Map<number, { type: "text"; text: string } | { type: "thinking"; text: string } | { type: "tool_use"; id: string; name: string; partialInputJson: string }>([
        [0, { type: "thinking", text: "reasoning" }],
        [1, { type: "text", text: "second" }],
      ]),
      stopped: false,
    })
    const out = synthesizePartialTurns(partials, new Set())
    expect(out).toHaveLength(2)
    expect(out[0].messageId).toBe("msg_1")
    expect(out[0].textBlocks).toEqual(["first"])
    expect(out[0].thinkingBlocks).toEqual([])
    expect(out[1].messageId).toBe("msg_2")
    expect(out[1].textBlocks).toEqual(["second"])
    expect(out[1].thinkingBlocks).toEqual(["reasoning"])
  })

  it("preserves block order from the Map (index order)", () => {
    const partials = new Map<string, PartialAssistantMessage>([
      [
        "msg_x",
        {
          messageId: "msg_x",
          blocks: new Map<number, { type: "text"; text: string } | { type: "thinking"; text: string } | { type: "tool_use"; id: string; name: string; partialInputJson: string }>([
            [0, { type: "text", text: "alpha" }],
            [1, { type: "text", text: "beta" }],
          ]),
          stopped: false,
        },
      ],
    ])
    const out = synthesizePartialTurns(partials, new Set())
    expect(out).toHaveLength(1)
    expect(out[0].textBlocks).toEqual(["alpha", "beta"])
  })

  it("skips tool_use blocks (v1 non-goal)", () => {
    const partials = new Map<string, PartialAssistantMessage>([
      [
        "msg_tool",
        {
          messageId: "msg_tool",
          blocks: new Map<number, { type: "text"; text: string } | { type: "thinking"; text: string } | { type: "tool_use"; id: string; name: string; partialInputJson: string }>([
            [0, { type: "text", text: "thinking about it..." }],
            [1, { type: "tool_use", id: "t1", name: "Read", partialInputJson: '{"path":' }],
          ]),
          stopped: false,
        },
      ],
    ])
    const out = synthesizePartialTurns(partials, new Set())
    expect(out).toHaveLength(1)
    expect(out[0].textBlocks).toEqual(["thinking about it..."])
    expect(out[0].thinkingBlocks).toEqual([])
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
