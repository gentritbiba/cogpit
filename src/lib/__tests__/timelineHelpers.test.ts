import { describe, expect, it } from "vitest"
import { matchesSearch } from "../timelineHelpers"
import type { Turn } from "../types"

function makeTurn(): Turn {
  return {
    id: "turn-1",
    userMessage: "Initial request",
    contentBlocks: [{
      kind: "queued_prompt",
      content: "Also verify the mobile layout",
      timestamp: "2025-01-15T10:00:01Z",
    }],
    thinking: [],
    assistantText: [],
    toolCalls: [],
    subAgentActivity: [],
    timestamp: "2025-01-15T10:00:00Z",
    durationMs: null,
    tokenUsage: null,
    model: "opus",
  }
}

describe("matchesSearch", () => {
  it("finds text from a prompt queued during an active turn", () => {
    expect(matchesSearch(makeTurn(), "mobile layout")).toBe(true)
  })
})
