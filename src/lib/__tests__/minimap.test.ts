import { describe, it, expect } from "vitest"
import { tickWidthClass, turnPreviewText, MINIMAP_MIN_TURNS } from "@/lib/minimap"
import type { Turn } from "@/lib/types"

function turn(userMessage: Turn["userMessage"]): Turn {
  return {
    id: "t1",
    userMessage,
    contentBlocks: [],
    thinking: [],
    assistantText: [],
    toolCalls: [],
    subAgentActivity: [],
    timestamp: "",
    durationMs: null,
    tokenUsage: null,
    model: null,
  }
}

describe("tickWidthClass", () => {
  it("gives the hovered tick the widest bar", () => {
    expect(tickWidthClass(0)).toBe("w-6")
  })

  it("tapers with distance from the cursor", () => {
    expect(tickWidthClass(1)).toBe("w-4")
    expect(tickWidthClass(2)).toBe("w-2.5")
    expect(tickWidthClass(3)).toBe("w-2")
  })

  it("clamps far ticks to the narrowest bar", () => {
    expect(tickWidthClass(12)).toBe("w-2")
  })

  it("rests at the narrowest bar when nothing is hovered", () => {
    expect(tickWidthClass(null)).toBe("w-2")
  })
})

describe("turnPreviewText", () => {
  it("reads a plain string prompt", () => {
    expect(turnPreviewText(turn("fix the parser"))).toBe("fix the parser")
  })

  it("joins the text blocks of a structured prompt", () => {
    const content = [
      { type: "text", text: "first" },
      { type: "image", source: {} },
      { type: "text", text: "second" },
    ] as unknown as Turn["userMessage"]

    expect(turnPreviewText(turn(content))).toBe("first second")
  })

  it("drops system tags so the rail shows what the user actually typed", () => {
    const text = "<system-reminder>ignore me</system-reminder>real request"

    expect(turnPreviewText(turn(text))).toBe("real request")
  })

  it("collapses whitespace so a multi-line prompt fits one line", () => {
    expect(turnPreviewText(turn("line one\n\n   line two"))).toBe("line one line two")
  })

  it("falls back to a label when a turn has no prompt", () => {
    expect(turnPreviewText(turn(null))).toBe("Untitled turn")
  })

  it("labels a promptless background-task fragment by what the task reported", () => {
    const t = turn(null)
    t.contentBlocks = [{
      kind: "task_notification",
      content: [
        "<task-notification><task-id>abc</task-id>",
        "<summary>Agent \"Docs audit\" finished</summary>",
        "</task-notification>",
      ].join("\n"),
    }]

    expect(turnPreviewText(t)).toBe('Agent "Docs audit" finished')
  })

  it("prefers the prompt over a task the same turn was resumed by", () => {
    const t = turn("ship the release")
    t.contentBlocks = [{
      kind: "task_notification",
      content: "<task-notification><summary>agent done</summary></task-notification>",
    }]

    expect(turnPreviewText(t)).toBe("ship the release")
  })

  it("prefers what the user typed over a task envelope in the same turn", () => {
    const text = "<task-notification><summary>agent done</summary></task-notification>\nnow ship it"

    expect(turnPreviewText(turn(text))).toBe("now ship it")
  })

  it("labels a turn with no prompt by what the agent said", () => {
    const t = turn(null)
    t.assistantText = ["Picked up where we left off."]

    expect(turnPreviewText(t)).toBe("Picked up where we left off.")
  })

  it("drops an interrupt marker from the label", () => {
    expect(turnPreviewText(turn("[Request interrupted by user]stop"))).toBe("stop")
  })
})

describe("MINIMAP_MIN_TURNS", () => {
  it("does not draw a rail for a conversation you can already see", () => {
    expect(MINIMAP_MIN_TURNS).toBeGreaterThan(1)
  })
})
