import { describe, expect, it } from "vitest"
import { collectActivity, matchesSearch, segmentActivity, type ActivityItem } from "../timelineHelpers"
import type { ThinkingBlock, ToolCall, Turn, TurnContentBlock } from "../../../shared/session/types"
import { emptyTurn } from "@/__tests__/fixtures"

const makeTurn = (overrides: Partial<Turn> = {}) =>
  emptyTurn({
    userMessage: "Initial request",
    model: "opus",
    timestamp: "2025-01-15T10:00:00Z",
    contentBlocks: [{
      kind: "queued_prompt",
      content: "Also verify the mobile layout",
      timestamp: "2025-01-15T10:00:01Z",
    }],
    ...overrides,
  })

describe("matchesSearch", () => {
  it("finds text from a prompt queued during an active turn", () => {
    expect(matchesSearch(makeTurn(), "mobile layout")).toBe(true)
  })

  it("matches an agent message by sender and by body", () => {
    const turn = makeTurn({
      contentBlocks: [{ kind: "agent_message", sender: "csp-and-proxy", body: "lenderdesk hardening" }],
    })

    expect(matchesSearch(turn, "csp-and")).toBe(true)
    expect(matchesSearch(turn, "lenderdesk")).toBe(true)
    expect(matchesSearch(turn, "nothing here")).toBe(false)
  })
})

function call(id: string): ToolCall {
  return { id, name: "Bash", input: {}, result: "ok", isError: false, timestamp: "2025-01-15T10:00:00Z" }
}

const thought = (thinking: string): ThinkingBlock => ({ type: "thinking", thinking, signature: thinking })

describe("collectActivity", () => {
  it("credits each thinking block with the time since the block before it", () => {
    const blocks: TurnContentBlock[] = [
      { kind: "tool_calls", toolCalls: [call("a")], timestamp: "2025-01-15T10:00:00Z" },
      { kind: "thinking", blocks: [thought("hmm")], timestamp: "2025-01-15T10:00:03Z" },
      { kind: "tool_calls", toolCalls: [call("b")], timestamp: "2025-01-15T10:00:04Z" },
    ]

    const { items, thoughtForMs } = collectActivity(blocks, 0)

    expect(items[1]).toEqual({ kind: "thinking", blocks: [thought("hmm")], thoughtForMs: 3_000 })
    expect(thoughtForMs).toBe(3_000)
  })
})

describe("segmentActivity", () => {
  const isSpawn = (toolCall: ToolCall) => toolCall.id.startsWith("spawn")

  it("keeps a run without spawns as one group", () => {
    const items: ActivityItem[] = [
      { kind: "tool_calls", toolCalls: [call("a"), call("b")] },
      { kind: "thinking", blocks: [thought("hmm")], thoughtForMs: 2_000 },
      { kind: "tool_calls", toolCalls: [call("c")] },
    ]

    expect(segmentActivity(items, isSpawn)).toEqual([{
      kind: "activity",
      items,
      toolCalls: [call("a"), call("b"), call("c")],
      thinkingCount: 1,
      thoughtForMs: 2_000,
    }])
  })

  it("cuts the run where a call starts a session, keeping the work on either side grouped", () => {
    const items: ActivityItem[] = [
      { kind: "thinking", blocks: [thought("plan"), thought("more")], thoughtForMs: 1_000 },
      { kind: "tool_calls", toolCalls: [call("a"), call("spawn-1"), call("b")] },
      { kind: "thinking", blocks: [thought("after")], thoughtForMs: 500 },
    ]

    const segments = segmentActivity(items, isSpawn)

    expect(segments.map((segment) => segment.kind)).toEqual(["activity", "spawn", "activity"])
    expect(segments[0]).toMatchObject({ toolCalls: [call("a")], thinkingCount: 2, thoughtForMs: 1_000 })
    expect(segments[1]).toEqual({ kind: "spawn", toolCall: call("spawn-1") })
    expect(segments[2]).toMatchObject({
      items: [{ kind: "tool_calls", toolCalls: [call("b")] }, items[2]],
      toolCalls: [call("b")],
      thinkingCount: 1,
      thoughtForMs: 500,
    })
  })

  it("gives back-to-back spawns their own rows without empty groups between them", () => {
    const items: ActivityItem[] = [{ kind: "tool_calls", toolCalls: [call("spawn-1"), call("spawn-2")] }]

    expect(segmentActivity(items, isSpawn)).toEqual([
      { kind: "spawn", toolCall: call("spawn-1") },
      { kind: "spawn", toolCall: call("spawn-2") },
    ])
  })
})
