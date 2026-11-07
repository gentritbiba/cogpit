import { describe, expect, it } from "vitest"
import { findInTurns, foldCase, occurrencesIn, turnMatches, turnSegments } from "../sessionFind"
import type { ThinkingBlock, ToolCall, Turn } from "../../../shared/session/types"
import { emptyTurn } from "@/__tests__/fixtures"

const thought = (thinking: string): ThinkingBlock => ({ type: "thinking", thinking, signature: thinking })
const call = (id: string, input: Record<string, unknown>, result: string | null = null): ToolCall =>
  ({ id, name: "Bash", input, result, isError: false, timestamp: "2026-01-01T00:00:00Z" })

function turn(id: string, overrides: Partial<Turn> = {}): Turn {
  return emptyTurn({ id, ...overrides })
}

describe("turn text index", () => {
  it("reads every part of a turn the timeline shows, in render order", () => {
    const t = turn("a", {
      compactionSummary: "summary of earlier work",
      userMessage: "<system-reminder>hidden</system-reminder>please fix the parser",
      contentBlocks: [
        { kind: "thinking", blocks: [thought("consider the lexer")] },
        { kind: "tool_calls", toolCalls: [call("c1", { command: "grep lexer src", flags: ["-n", 3] }, "src/lexer.ts:12")] },
        { kind: "text", text: ["The lexer", "is fixed"] },
        { kind: "queued_prompt", content: "also check mobile" },
        { kind: "agent_message", sender: "csp-and-proxy", body: "lenderdesk hardening" },
      ],
    })
    const segments = turnSegments(t)
    expect(segments.map((s) => s.part.kind)).toEqual(["compaction", "prompt", "thinking", "tool", "block", "block", "block"])
    expect(segments[1].text).toBe("please fix the parser")
    expect(segments[3].text).toBe("grep lexer src\n-n\n3\nsrc/lexer.ts:12")
    expect(segments[3].part).toEqual({ kind: "tool", block: 1, callId: "c1" })
    // Cached per Turn object.
    expect(turnSegments(t)).toBe(segments)
  })

  it("does not index what the timeline never renders: tool names, JSON syntax and system tags", () => {
    const t = turn("a", {
      userMessage: "<system-reminder>secret</system-reminder>hello",
      contentBlocks: [{ kind: "tool_calls", toolCalls: [call("c1", { file_path: "/x.ts" })] }],
    })
    expect(turnMatches(t, "secret")).toBe(false)
    expect(turnMatches(t, "bash")).toBe(false)
    expect(turnMatches(t, "file_path")).toBe(false)
    expect(turnMatches(t, "/X.TS")).toBe(true)
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
    const hits = findInTurns(turns, "Needle")
    expect(hits).toEqual([{ turn: 3, segment: 0 }, { turn: 3, segment: 0 }, { turn: 399, segment: 0 }])
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
    const hits = findInTurns(turns, "folded idea")
    expect(hits.map((hit) => turnSegments(turns[0])[hit.segment].part.kind)).toEqual(["compaction", "thinking", "tool"])
  })

  it("counts non-overlapping occurrences, and an empty query finds nothing", () => {
    expect(findInTurns([turn("a", { contentBlocks: [{ kind: "text", text: ["aaaa"] }] })], "aa")).toHaveLength(2)
    expect(findInTurns([turn("a", { contentBlocks: [{ kind: "text", text: ["aaaa"] }] })], "")).toEqual([])
  })
})

describe("foldCase", () => {
  it("keeps every offset where lower-casing would change the length", () => {
    const text = "İstanbul NEEDLE"
    expect(foldCase(text)).toHaveLength(text.length)
    expect(occurrencesIn(foldCase(text), "needle")).toEqual([9])
  })
})
