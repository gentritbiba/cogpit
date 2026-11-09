import { describe, expect, it } from "vitest"
import { findInTurns, firstGroupOfTurn, groupOfHit, occurrencesIn, queryPattern, turnMatches, turnSegments } from "../sessionFind"
import type { ThinkingBlock, ToolCall, Turn } from "../../../shared/session/types"
import { emptyTurn } from "@/__tests__/fixtures"

const thought = (thinking: string): ThinkingBlock => ({ type: "thinking", thinking, signature: thinking })
const call = (id: string, input: Record<string, unknown>, result: string | null = null): ToolCall =>
  ({ id, name: "Bash", input, result, isError: false, timestamp: "2026-01-01T00:00:00Z" })

function turn(id: string, overrides: Partial<Turn> = {}): Turn {
  return emptyTurn({ id, ...overrides })
}

describe("turn text index", () => {
  it("reads every part of a turn the timeline shows, in render order, from the turn's own strings", () => {
    const result = "src/lexer.ts:12"
    const t = turn("a", {
      compactionSummary: "summary of earlier work",
      userMessage: "<system-reminder>hidden</system-reminder>please fix the parser",
      contentBlocks: [
        { kind: "thinking", blocks: [thought("consider the lexer")] },
        { kind: "tool_calls", toolCalls: [call("c1", { command: "grep lexer src", flags: ["-n"] }, result)] },
        { kind: "text", text: ["The lexer", "is fixed"] },
        { kind: "agent_message", sender: "csp-and-proxy", body: "lenderdesk hardening", reply: { summary: "answered", timestamp: "t" } },
        { kind: "task_notification", content: "<task-notification><summary>build passed</summary></task-notification>" },
      ],
    })
    const segments = turnSegments(t)
    expect(segments.map((s) => s.text.trim())).toEqual([
      "summary of earlier work", "please fix the parser", "consider the lexer",
      "grep lexer src", "-n", result, "The lexer", "is fixed",
      "csp-and-proxy", "lenderdesk hardening", "answered", "build passed",
    ])
    expect(segments[3].part).toEqual({ kind: "tool", block: 1, callId: "c1", result: false })
    expect(segments[5].part).toEqual({ kind: "tool", block: 1, callId: "c1", result: true })
    // The result is the turn's own string, not a copy; the index is cached per Turn object.
    expect(segments[5].text).toBe(result)
    expect(turnSegments(t)).toBe(segments)
  })

  it("leaves out what the timeline hides, and the filter still matches tool names", () => {
    const t = turn("a", {
      userMessage: "<system-reminder>secret</system-reminder>hello",
      toolCalls: [call("c1", { file_path: "/x.ts" })],
      contentBlocks: [{ kind: "tool_calls", toolCalls: [call("c1", { file_path: "/x.ts" })] }],
    })
    expect(turnMatches(t, "secret")).toBe(false)
    expect(turnMatches(t, "file_path")).toBe(false)
    expect(turnMatches(t, "/X.TS")).toBe(true)
    expect(turnMatches(t, "bash")).toBe(true)
    expect(findInTurns([t], "bash").total).toBe(0)
  })

  it("matches queued prompts and agent messages by sender and body", () => {
    const t = turn("a", {
      contentBlocks: [
        { kind: "queued_prompt", content: "Also verify the mobile layout" },
        { kind: "agent_message", sender: "csp-and-proxy", body: "lenderdesk hardening" },
      ],
    })
    expect(turnMatches(t, "mobile layout")).toBe(true)
    expect(turnMatches(t, "csp-and")).toBe(true)
    expect(turnMatches(t, "lenderdesk")).toBe(true)
    expect(turnMatches(t, "nothing here")).toBe(false)
  })
})

describe("findInTurns", () => {
  it("counts every occurrence over all loaded turns in timeline order, mounted or not", () => {
    // 400 turns, as a long session where only a viewport of rows is mounted.
    const turns = Array.from({ length: 400 }, (_, i) => turn(`t${i}`, {
      contentBlocks: [{ kind: "text", text: [i === 3 ? "needle and NEEDLE" : i === 399 ? "a needle" : "hay"] }],
    }))
    const results = findInTurns(turns, "Needle")
    expect(results.total).toBe(3)
    expect(results.groups).toEqual([{ turn: 3, segment: 0, count: 2 }, { turn: 399, segment: 0, count: 1 }])
    expect([0, 1, 2].map((i) => results.groups[groupOfHit(results, i)].turn)).toEqual([3, 3, 399])
    expect(firstGroupOfTurn(results, 399)).toBe(1)
    expect(firstGroupOfTurn(results, 4)).toBe(-1)
  })

  it("counts matches inside content the timeline keeps collapsed", () => {
    const turns = [turn("a", {
      contentBlocks: [
        { kind: "thinking", blocks: [thought("folded idea")] },
        { kind: "tool_calls", toolCalls: [call("c1", { command: "ls" }, "line\n".repeat(50) + "folded idea in a long result")] },
        { kind: "text", text: ["done"] },
      ],
      compactionSummary: "a folded idea from before",
    })]
    const results = findInTurns(turns, "folded idea")
    expect(results.groups.map((g) => turnSegments(turns[0])[g.segment].part.kind)).toEqual(["compaction", "thinking", "tool"])
  })

  it("recounts only the turns a live update replaced", () => {
    const stable = turn("a", { contentBlocks: [{ kind: "text", text: ["needle"] }] })
    const first = findInTurns([stable, turn("b")], "needle")
    const grown = turn("b", { contentBlocks: [{ kind: "text", text: ["needle needle"] }] })
    expect(first.total).toBe(1)
    expect(findInTurns([stable, grown], "needle").total).toBe(3)
  })

  it("treats the query literally, counts non-overlapping occurrences, and finds nothing for an empty query", () => {
    expect(findInTurns([turn("a", { contentBlocks: [{ kind: "text", text: ["aaaa"] }] })], "aa").total).toBe(2)
    expect(findInTurns([turn("a", { contentBlocks: [{ kind: "text", text: ["a.b axb (x)"] }] })], "a.b").total).toBe(1)
    expect(findInTurns([turn("a", { contentBlocks: [{ kind: "text", text: ["(x)"] }] })], "(x)").total).toBe(1)
    expect(findInTurns([turn("a", { contentBlocks: [{ kind: "text", text: ["aaaa"] }] })], "").total).toBe(0)
  })
})

describe("queryPattern", () => {
  it("keeps offsets in the original text, whatever lower-casing does to its length", () => {
    expect(occurrencesIn("İstanbul NEEDLE", queryPattern("needle")!)).toEqual([[9, 15]])
  })
})
