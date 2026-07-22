import { describe, expect, it } from "vitest"
import type { Turn } from "@/lib/types"
import { collectSessionImageItems } from "../SessionImageGallery"

function makeTurn(id: string, content: Turn["userMessage"]): Turn {
  return {
    id,
    userMessage: content,
    contentBlocks: [],
    thinking: [],
    assistantText: [],
    toolCalls: [],
    subAgentActivity: [],
    timestamp: "2026-07-22T00:00:00.000Z",
    durationMs: null,
    tokenUsage: null,
    model: null,
  }
}

describe("collectSessionImageItems", () => {
  it("collects attachments in session order with stable turn labels", () => {
    const turns = [
      makeTurn("turn-1", [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "Zmlyc3Q=" } },
        { type: "text", text: "first" },
      ]),
      makeTurn("turn-2", "no image"),
      makeTurn("turn-3", [
        { type: "image", source: { type: "base64", media_type: "image/webp", data: "c2Vjb25k" } },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "dGhpcmQ=" } },
      ]),
    ]

    const items = collectSessionImageItems(turns)

    expect(items.map((item) => item.id)).toEqual([
      "turn-1:attachment:0",
      "turn-3:attachment:0",
      "turn-3:attachment:1",
    ])
    expect(items.map((item) => item.label)).toEqual([
      "Turn 1 · Image 1",
      "Turn 3 · Image 1",
      "Turn 3 · Image 2",
    ])
    expect(items[1].src).toBe("data:image/webp;base64,c2Vjb25k")
  })
})
