import { describe, expect, it } from "vitest"
import { decisionsMessage, parseCogpitBlock } from "../parse"

describe("parseCogpitBlock", () => {
  it("rejects duplicate explicit ids and collisions with generated ids", () => {
    expect(parseCogpitBlock("decisions", "- { id: same, question: First?, options: [Yes, No] }\n- { id: same, question: Second?, options: [A, B] }")).toBeNull()
    expect(parseCogpitBlock("decisions", "- { id: '2', question: First?, options: [Yes, No] }\n- { question: Second?, options: [A, B] }")).toBeNull()
  })

  it("reads a status block: progress, values and their tone", () => {
    const block = parseCogpitBlock("status", [
      "title: Wave 3 · 99 tickets",
      "progress: { done: 35, total: 99 }",
      "values:",
      "  - { label: Merged today, value: 7 pull requests }",
      "  - { label: Blocked on you, value: 4, tone: warning }",
      "  - { label: Odd tone, value: x, tone: purple }",
    ].join("\n"))
    expect(block).toEqual({
      kind: "status",
      title: "Wave 3 · 99 tickets",
      progress: { done: 35, total: 99 },
      values: [
        { label: "Merged today", value: "7 pull requests" },
        { label: "Blocked on you", value: "4", tone: "warning" },
        { label: "Odd tone", value: "x" },
      ],
    })
  })

  it("reads decisions from a list or under a key, with options and a recommendation", () => {
    const source = [
      "- id: sharp",
      "  question: Bump sharp to 0.34 through its own PR?",
      "  options: [Approve, Later, No]",
      "  recommended: Approve",
      "  detail: Separate worktree, merges when CI is green.",
      "- question: Deploy the status page Worker?",
      "  options: [Approve, Hold]",
    ].join("\n")
    const block = parseCogpitBlock("decisions", source)
    expect(block).toEqual({
      kind: "decisions",
      decisions: [
        { id: "sharp", question: "Bump sharp to 0.34 through its own PR?", options: ["Approve", "Later", "No"], recommended: "Approve", detail: "Separate worktree, merges when CI is green." },
        { id: "2", question: "Deploy the status page Worker?", options: ["Approve", "Hold"] },
      ],
    })
    expect(parseCogpitBlock("decisions", `title: Three calls\ndecisions:\n${source.replace(/^/gm, "  ")}`))
      .toMatchObject({ title: "Three calls", decisions: [{ id: "sharp" }, { id: "2" }] })
  })

  it("drops a recommendation that is not one of the options", () => {
    const block = parseCogpitBlock("decisions", "- question: Ship?\n  options: [Yes, No]\n  recommended: Maybe")
    expect(block).toEqual({ kind: "decisions", decisions: [{ id: "1", question: "Ship?", options: ["Yes", "No"] }] })
  })

  it("reads a checklist with states, notes and bare strings", () => {
    const block = parseCogpitBlock("checklist", [
      "title: Shipping w3-rooftop",
      "items:",
      "  - { text: Fix the P1, state: done }",
      "  - { text: Codex review round 3, state: doing, note: running }",
      "  - { text: Apply the ruleset, state: blocked }",
      "  - Open the PR",
      "  - { text: Old idea, state: nonsense }",
    ].join("\n"))
    expect(block).toEqual({
      kind: "checklist",
      title: "Shipping w3-rooftop",
      items: [
        { text: "Fix the P1", state: "done" },
        { text: "Codex review round 3", state: "doing", note: "running" },
        { text: "Apply the ruleset", state: "blocked" },
        { text: "Open the PR", state: "todo" },
        { text: "Old idea", state: "todo" },
      ],
    })
  })

  it("accepts JSON, which is YAML too", () => {
    expect(parseCogpitBlock("checklist", `[{"text": "a", "state": "done"}]`)).toEqual({ kind: "checklist", items: [{ text: "a", state: "done" }] })
  })

  it("is null for a block it cannot read, so the code shows instead", () => {
    expect(parseCogpitBlock("status", "title: [unclosed")).toBeNull()
    expect(parseCogpitBlock("status", "just a sentence")).toBeNull()
    expect(parseCogpitBlock("decisions", "- question: No options")).toBeNull()
    expect(parseCogpitBlock("checklist", "items: []")).toBeNull()
  })
})

describe("decisionsMessage", () => {
  it("sends the answers back as one message, in the block's order", () => {
    const decisions = [
      { id: "sharp", question: "Bump sharp?", options: ["Approve", "Later"] },
      { id: "sentry", question: "Run sentry-cli login today?", options: ["Now", "Later"] },
      { id: "worker", question: "Deploy the Worker?", options: ["Approve", "Hold"] },
    ]
    expect(decisionsMessage(decisions, { worker: "Hold", sharp: "Approve" })).toBe(
      "Decisions:\n- sharp: Bump sharp? Approve\n- worker: Deploy the Worker? Hold",
    )
  })
})
