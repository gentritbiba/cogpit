import { describe, expect, it } from "vitest"
import { getTurnKey } from "../stats/turnKey"
import type { Turn } from "@/lib/types"

function makeTurn(userMessage: string): Turn {
  return {
    id: "shared-live-turn-id",
    userMessage,
    contentBlocks: [],
    thinking: [],
    assistantText: [],
    toolCalls: [],
    subAgentActivity: [],
    timestamp: "2026-01-01T00:00:00.000Z",
    durationMs: null,
    tokenUsage: null,
    model: null,
  }
}

describe("TurnNavigator", () => {
  it("gives live turns unique keys even when their persisted ids collide", () => {
    const turns = [makeTurn("first"), makeTurn("second")]

    expect(getTurnKey(turns[0], 0)).not.toBe(getTurnKey(turns[1], 1))
  })
})
