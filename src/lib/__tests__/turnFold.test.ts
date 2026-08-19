import { describe, it, expect } from "vitest"
import { planTurnFold, turnFoldLabel } from "@/lib/turnFold"
import type { TurnContentBlock, ToolCall, ThinkingBlock } from "@/lib/types"

function tool(name: string): ToolCall {
  return { id: `t-${name}`, name, input: {}, timestamp: "" } as ToolCall
}
function thinking(text: string): ThinkingBlock {
  return { thinking: text } as ThinkingBlock
}

const text = (...t: string[]): TurnContentBlock => ({ kind: "text", text: t })
const tools = (...names: string[]): TurnContentBlock => ({
  kind: "tool_calls",
  toolCalls: names.map(tool),
})
const thoughts = (...t: string[]): TurnContentBlock => ({
  kind: "thinking",
  blocks: t.map(thinking),
})

describe("planTurnFold", () => {
  it("folds work and commentary, keeping the terminal assistant message", () => {
    const blocks = [text("Let me look"), tools("Read", "Grep"), text("Done — here it is")]

    const plan = planTurnFold(blocks)

    expect(plan.foldable).toBe(true)
    // The trailing text block is what survives.
    expect(plan.foldedIndices).toEqual([0, 1])
    expect(plan.foldAnchorIndex).toBe(0)
    expect(plan.hiddenToolCalls).toBe(2)
  })

  it("does not fold a turn that is only prose", () => {
    // Multiple text blocks with no work is one long answer, not commentary.
    const plan = planTurnFold([text("part one"), text("part two")])

    expect(plan.foldable).toBe(false)
    expect(plan.foldedIndices).toEqual([])
  })

  it("does not fold when there is no terminal assistant message", () => {
    // An interrupted turn ends on work. Folding would hide the whole turn,
    // so it stays open and the user keeps their place.
    const plan = planTurnFold([tools("Bash"), thoughts("hmm")])

    expect(plan.foldable).toBe(false)
  })

  it("folds an active turn before it has a final message", () => {
    const plan = planTurnFold([text("Checking now"), tools("Bash"), thoughts("hmm")], "working")

    expect(plan.foldable).toBe(true)
    expect(plan.foldedIndices).toEqual([0, 1, 2])
    expect(plan.foldAnchorIndex).toBe(0)
  })

  it("keeps pinned blocks visible while active work is folded", () => {
    const plan = planTurnFold([
      tools("Read"),
      { kind: "queued_prompt", content: "also check this" },
      text("Still working"),
    ], "working")

    expect(plan.foldedIndices).toEqual([0, 2])
  })

  it("keeps user-facing blocks visible even when they precede the terminal message", () => {
    const blocks: TurnContentBlock[] = [
      tools("Read"),
      { kind: "queued_prompt", content: "also do this" },
      { kind: "plan_mode", plan: "the plan", status: "approved", toolCalls: [] },
      { kind: "recap", content: "summary" },
      text("finished"),
    ]

    const plan = planTurnFold(blocks)

    expect(plan.foldable).toBe(true)
    expect(plan.foldedIndices).toEqual([0])
  })

  it("folds nested agent transcripts and hook events", () => {
    const blocks: TurnContentBlock[] = [
      { kind: "sub_agent", messages: [] },
      { kind: "background_agent", messages: [] },
      { kind: "hook_event", events: [] },
      text("all done"),
    ]

    const plan = planTurnFold(blocks)

    expect(plan.foldedIndices).toEqual([0, 1, 2])
  })

  it("counts tool calls across every folded block", () => {
    const plan = planTurnFold([tools("Read"), thoughts("x"), tools("Edit", "Write"), text("ok")])

    expect(plan.hiddenToolCalls).toBe(3)
  })

  it("anchors the fold control at the first hidden block", () => {
    const plan = planTurnFold([
      { kind: "queued_prompt", content: "go" },
      tools("Read"),
      text("done"),
    ])

    expect(plan.foldAnchorIndex).toBe(1)
  })

  it("treats an empty turn as unfoldable", () => {
    expect(planTurnFold([]).foldable).toBe(false)
  })
})

describe("turnFoldLabel", () => {
  it("reports how long the turn took", () => {
    expect(turnFoldLabel(47_000, 3)).toBe("Worked for 47s")
  })

  it("falls back to tool count when the turn has no measured duration", () => {
    expect(turnFoldLabel(null, 3)).toBe("Worked through 3 steps")
    expect(turnFoldLabel(null, 1)).toBe("Worked through 1 step")
  })

  it("stays honest when there is nothing to count", () => {
    expect(turnFoldLabel(null, 0)).toBe("Show work")
  })
})
