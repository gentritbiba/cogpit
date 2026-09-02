import { describe, expect, it } from "vitest"

import {
  cutLineAfterTurnIndex,
  cutLineAfterUuid,
  cutLineForTurnCount,
  formatFor,
  turnBoundaryLines,
} from "../../../shared/session/agents"
import { findCutoffLine, findCutoffLineForTurn } from "@/hooks/undo/undoHelpers"

/**
 * The one turn-boundary scan, and the thing it exists to prevent.
 *
 * Undo is a two-sided cut: the client computes `keepLines` from its copy of the
 * transcript and the server verifies that count before truncating the file. The
 * two used to scan separately, and disagreed — the client rejected a user
 * record carrying *any* `tool_result` block, the server only one where *every*
 * block was a tool result — so a mixed-content record was a boundary on one
 * side and not the other, and the cut silently landed a turn off. Both now call
 * the same function, and the case they disagreed on is pinned below.
 */

const claude = formatFor("claude")
const codex = formatFor("codex")
const copilot = formatFor("copilot")

function jsonl(records: unknown[]): string[] {
  return records.map((record) => JSON.stringify(record))
}

/** A user record carrying a tool result *and* text — the disputed shape. */
const MIXED_CONTENT = {
  type: "user",
  uuid: "mixed-1",
  message: {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "tool-1", content: "ok" },
      { type: "text", text: "and also do this" },
    ],
  },
}

const CLAUDE_LINES = jsonl([
  { type: "user", uuid: "u1", message: { role: "user", content: "first ask" } },
  { type: "assistant", uuid: "a1", message: { role: "assistant", content: [] } },
  MIXED_CONTENT,
  { type: "assistant", uuid: "a2", message: { role: "assistant", content: [] } },
  { type: "user", uuid: "u2", message: { role: "user", content: "second ask" } },
  { type: "assistant", uuid: "a3", message: { role: "assistant", content: [] } },
])

describe("Claude turn boundaries", () => {
  it("treats a record mixing a tool result with text as a continuation", () => {
    // The whole point: index 2 is NOT a boundary. Reading it as one would make
    // "keep one turn" cut at line 2 on one side and line 4 on the other.
    expect(turnBoundaryLines(claude, CLAUDE_LINES)).toEqual([0, 4])
  })

  it("cuts a mixed-content transcript at the same line on both sides", () => {
    const keepOneTurn = 1
    expect(findCutoffLine([...CLAUDE_LINES], keepOneTurn, "-tmp-project")).toBe(4)
    expect(cutLineForTurnCount(claude, CLAUDE_LINES, keepOneTurn)).toBe(4)
    expect(cutLineAfterTurnIndex(claude, CLAUDE_LINES, 0)).toBe(4)
  })

  it("keeps everything when the transcript has no further turn", () => {
    expect(cutLineForTurnCount(claude, CLAUDE_LINES, 2)).toBe(CLAUDE_LINES.length)
    expect(cutLineAfterTurnIndex(claude, CLAUDE_LINES, 1)).toBeNull()
  })

  it("skips meta records and tool-result-only records", () => {
    const lines = jsonl([
      { type: "user", isMeta: true, message: { role: "user", content: "caveat" } },
      { type: "user", message: { role: "user", content: "real ask" } },
      {
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
      },
    ])
    expect(turnBoundaryLines(claude, lines)).toEqual([1])
  })

  it("cuts after the turn containing a uuid, however much of the file is loaded", () => {
    expect(cutLineAfterUuid(claude, CLAUDE_LINES, "u1")).toBe(4)
    // A uuid inside the last turn leaves nothing to remove.
    expect(cutLineAfterUuid(claude, CLAUDE_LINES, "u2")).toBe("keep-all")
    expect(cutLineAfterUuid(claude, CLAUDE_LINES, "not-here")).toBeNull()
  })

  it("ignores a malformed line instead of shifting every index after it", () => {
    const lines = ["{not json", ...CLAUDE_LINES]
    expect(turnBoundaryLines(claude, lines)).toEqual([1, 5])
  })
})

describe("Codex turn boundaries", () => {
  const lines = jsonl([
    { type: "session_meta", payload: { id: "s1" } },
    { type: "turn_context", payload: { cwd: "/tmp" } },
    { type: "event_msg", payload: { type: "user_message", message: "first ask" } },
    { type: "response_item", payload: { type: "message", role: "assistant" } },
    { type: "turn_context", payload: { cwd: "/tmp" } },
    { type: "event_msg", payload: { type: "user_message", message: "second ask" } },
  ])

  it("reports the turn_context line, not the user message it configures", () => {
    // Cutting at the user message would strand a context record belonging to a
    // turn that no longer exists.
    expect(turnBoundaryLines(codex, lines)).toEqual([1, 4])
    expect(cutLineForTurnCount(codex, lines, 1)).toBe(4)
  })

  it("does not open a second turn for an event carrying no message text", () => {
    const partial = jsonl([
      { type: "event_msg", payload: { type: "user_message" } },
      { type: "event_msg", payload: { type: "user_message", message: "real" } },
    ])
    // One turn, and it starts at the record that opened it. Reporting line 1
    // would strand line 0 outside every turn — the same mistake as cutting at a
    // prompt instead of the `turn_context` that configures it.
    expect(turnBoundaryLines(codex, partial)).toEqual([0])
    expect(codex.parse(partial.join("\n")).turns).toHaveLength(1)
  })
})

describe("Copilot turn boundaries", () => {
  it("counts only addressable top-level user messages", () => {
    const lines = jsonl([
      { type: "session.start", id: "e0", data: {} },
      { type: "user.message", id: "e1", data: { turnId: "t1" } },
      { type: "assistant.message", id: "e2", data: {} },
      // A sub-agent's own prompt belongs to the turn already in flight.
      { type: "user.message", id: "e3", agentId: "sub-1", data: { turnId: "t1" } },
      // Without a durable id the CLI cannot fork or rewind to it.
      { type: "user.message", data: { turnId: "t2" } },
      { type: "user.message", id: "e5", data: { turnId: "t2" } },
    ])
    expect(turnBoundaryLines(copilot, lines)).toEqual([1, 5])
  })
})

/**
 * The other way a two-sided cut goes wrong: the client's turn indexes and the
 * file's turn indexes are not the same number.
 *
 * `session.turns` is only the loaded tail of a long session, but undo reads the
 * whole file before cutting. Counting turns from the top of the file while the
 * user picked the Nth turn of the *window* deletes everything in between, and
 * the server cannot catch it — it only checks the line count, which matches
 * because both sides read the same file.
 */
describe("cutting a window-relative turn out of a full transcript", () => {
  const fullFile = jsonl([
    { type: "user", uuid: "u1", message: { role: "user", content: "one" } },
    { type: "assistant", uuid: "a1", message: { role: "assistant", content: [] } },
    { type: "user", uuid: "u2", message: { role: "user", content: "two" } },
    { type: "assistant", uuid: "a2", message: { role: "assistant", content: [] } },
    { type: "user", uuid: "u3", message: { role: "user", content: "three" } },
    { type: "assistant", uuid: "a3", message: { role: "assistant", content: [] } },
    { type: "user", uuid: "u4", message: { role: "user", content: "four" } },
    { type: "assistant", uuid: "a4", message: { role: "assistant", content: [] } },
  ])

  // The user scrolled a 4-turn session that only paged in the last two turns,
  // so "keep through the first visible turn" means turn 3 of the file.
  const loadedWindow = [{ id: "u3" }, { id: "u4" }] as Parameters<
    typeof findCutoffLineForTurn
  >[1][]

  it("anchors the cut to the turn, not to its position in the window", () => {
    expect(findCutoffLineForTurn(fullFile, loadedWindow[0], 1, null)).toBe(6)
  })

  it("is the bug: the same cut by window index keeps one turn instead of three", () => {
    expect(findCutoffLine(fullFile, 1, null)).toBe(2)
  })

  it("falls back to the index cut when the turn carries no matchable id", () => {
    expect(findCutoffLineForTurn(fullFile, { id: "not-in-file" } as never, 3, null))
      .toBe(findCutoffLine(fullFile, 3, null))
  })

  it("keeps the whole file when the last turn is the one retained", () => {
    expect(findCutoffLineForTurn(fullFile, loadedWindow[1], 2, null)).toBe(fullFile.length)
  })
})

/**
 * The property that unit-testing a predicate cannot express.
 *
 * Boundaries exist to cut a transcript, so the only contract that matters is
 * that cutting at `boundaries[k]` and re-parsing yields exactly `k` turns. A
 * predicate that merely *looks* like the parser's turn rule can satisfy every
 * hand-written example and still disagree on real data — which is how the
 * modern-Codex regression below survived a green suite.
 */
function assertBoundaryRoundTrip(format: typeof codex, lines: string[]) {
  const boundaries = turnBoundaryLines(format, lines)
  expect(boundaries).toHaveLength(format.parse(lines.join("\n")).turns.length)
  boundaries.forEach((cut, k) => {
    expect(format.parse(lines.slice(0, cut).join("\n")).turns).toHaveLength(k)
  })
}

describe("boundaries agree with the parser", () => {
  it("holds for a modern Codex rollout (response_item prompts)", () => {
    // Codex 0.151+ stopped writing `event_msg/user_message` entirely. The old
    // boundary scan only matched that shape, so it returned [] for every
    // current rollout and undo silently kept nothing.
    const lines = jsonl([
      { type: "session_meta", payload: { id: "s1" } },
      { type: "turn_context", payload: { cwd: "/tmp" } },
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "first" }] },
      },
      {
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
      },
      { type: "turn_context", payload: { cwd: "/tmp" } },
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "second" }] },
      },
    ])
    expect(turnBoundaryLines(codex, lines)).not.toEqual([])
    assertBoundaryRoundTrip(codex, lines)
  })

  it("holds for legacy Codex rollouts (event_msg prompts)", () => {
    assertBoundaryRoundTrip(codex, jsonl([
      { type: "session_meta", payload: { id: "s1" } },
      { type: "turn_context", payload: { cwd: "/tmp" } },
      { type: "event_msg", payload: { type: "user_message", message: "first ask" } },
      { type: "response_item", payload: { type: "message", role: "assistant" } },
      { type: "turn_context", payload: { cwd: "/tmp" } },
      { type: "event_msg", payload: { type: "user_message", message: "second ask" } },
    ]))
  })

  it("holds when Codex repeats a prompt without an intervening reply", () => {
    // The parser folds consecutive prompts into one turn; a per-prompt scan
    // counted two, so "keep 3 turns" silently cut several turns too early.
    assertBoundaryRoundTrip(codex, jsonl([
      { type: "event_msg", payload: { type: "user_message", message: "same ask" } },
      { type: "event_msg", payload: { type: "user_message", message: "same ask" } },
      { type: "response_item", payload: { type: "message", role: "assistant" } },
      { type: "event_msg", payload: { type: "user_message", message: "next" } },
    ]))
  })
})
