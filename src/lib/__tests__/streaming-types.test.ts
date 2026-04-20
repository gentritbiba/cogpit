import { describe, it, expectTypeOf } from "vitest"
import type { StreamEventSSE, PartialAssistantMessage, PartialContentBlock } from "@/lib/types"

describe("streaming types", () => {
  it("StreamEventSSE has required fields", () => {
    const sample: StreamEventSSE = {
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } },
      parent_tool_use_id: null,
    }
    expectTypeOf(sample).toHaveProperty("type")
    expectTypeOf(sample).toHaveProperty("event")
  })

  it("PartialAssistantMessage groups blocks by index", () => {
    const sample: PartialAssistantMessage = {
      messageId: "msg_123",
      blocks: new Map<number, PartialContentBlock>([
        [0, { type: "text", text: "hello" }],
      ]),
      stopped: false,
    }
    expectTypeOf(sample.blocks).toMatchTypeOf<Map<number, PartialContentBlock>>()
  })
})
