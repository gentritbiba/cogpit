import { describe, it, expect } from "vitest"
import { planTurnFold, turnFoldLabel } from "@/lib/turnFold"
import type { TurnContentBlock, ToolCall, ThinkingBlock } from "../../../shared/session/types"

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

  it("never folds away the task notification that resumed the turn", () => {
    const blocks: TurnContentBlock[] = [
      tools("Read"),
      text("Waiting on CI."),
      { kind: "task_notification", content: "<task-notification></task-notification>" },
      tools("Bash"),
      text("Merged."),
    ]

    const plan = planTurnFold(blocks)

    expect(plan.foldedIndices).toEqual([0, 1, 3])
  })

  it("never folds an agent message away", () => {
    const blocks: TurnContentBlock[] = [
      thoughts("planning"),
      { kind: "agent_message", sender: "csp-and-proxy", body: "one blocking question" },
      tools("Read"),
      text("done"),
    ]

    const plan = planTurnFold(blocks)

    expect(plan.foldedIndices).not.toContain(1)
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

// ── Interactive prompts ──────────────────────────────────────────────────────

/**
 * A question-blocked session writes nothing to its JSONL, so `isLive` goes false
 * ~30s after the prompt and the turn reads as settled. The fold must not treat
 * that as "work finished" and hide the one thing the turn is waiting on.
 */
const askUserQuestion = (result: string | null): TurnContentBlock => ({
  kind: "tool_calls",
  toolCalls: [{
    id: "t-ask",
    name: "AskUserQuestion",
    input: { questions: [{ question: "Which one?", options: [{ label: "A" }] }] },
    result,
    isError: false,
    timestamp: "",
  }],
})

describe("planTurnFold — unanswered prompts", () => {
  it("never folds an unanswered AskUserQuestion in a settled turn", () => {
    const blocks = [text("Which is my one question for now:"), askUserQuestion(null)]

    const plan = planTurnFold(blocks)

    expect(plan.foldedIndices).not.toContain(1)
  })

  it("never folds an unanswered AskUserQuestion in a working turn", () => {
    const blocks = [text("Checking"), tools("Read"), askUserQuestion(null)]

    const plan = planTurnFold(blocks, "working")

    expect(plan.foldedIndices).not.toContain(2)
  })

  it("folds an answered AskUserQuestion like any other tool call", () => {
    const blocks = [askUserQuestion('"Which one?" = "A"'), text("Going with A")]

    const plan = planTurnFold(blocks)

    expect(plan.foldedIndices).toEqual([0])
  })

  it("excludes a pinned prompt from the hidden-step count", () => {
    const blocks = [tools("Read"), text("Here is what I found:"), askUserQuestion(null)]

    const plan = planTurnFold(blocks)

    expect(plan.hiddenToolCalls).toBe(1)
  })

  it("folds a prompt the agent gave up on and answered itself", () => {
    // Assistant content after the prompt means the turn is not blocked on it,
    // so it is ordinary history — the same test detectPendingInteraction makes.
    const blocks = [askUserQuestion(null), text("No reply, so I picked A")]

    const plan = planTurnFold(blocks)

    expect(plan.foldedIndices).toEqual([0])
  })

  it("pins a prompt trailed only by non-assistant blocks", () => {
    const blocks: TurnContentBlock[] = [
      text("One question:"),
      tools("Read"),
      askUserQuestion(null),
      { kind: "hook_event", events: [] },
    ]

    const plan = planTurnFold(blocks)

    expect(plan.foldedIndices).toEqual([1, 3])
  })

  it("stays unfoldable when the only work is an unanswered prompt", () => {
    // Folding would hide nothing, so the disclosure would be a dead control.
    const plan = planTurnFold([text("One question:"), askUserQuestion(null)])

    expect(plan.foldable).toBe(false)
  })
})
