import { describe, it, expect, beforeEach } from "vitest"
import {
  isNearTop,
  isPrepend,
  prependTurns,
  shouldShowEmptyState,
  NEAR_TOP_VIEWPORTS,
} from "@/lib/timelinePaging"
import { parseSession } from "@/lib/parser"
import {
  peerAttachment,
  peerEnqueueMsg,
  resetFixtureCounter,
  textAssistant,
  toJsonl,
  toolUseAssistant,
  userMsg,
} from "@/__tests__/fixtures"
import type { Turn, TurnContentBlock } from "@/lib/types"

function makeTurn(id: string, overrides: Partial<Turn> = {}): Turn {
  return {
    id,
    userMessage: `msg-${id}`,
    contentBlocks: [],
    thinking: [],
    assistantText: [],
    toolCalls: [],
    subAgentActivity: [],
    timestamp: "2026-07-23T10:00:00Z",
    durationMs: null,
    tokenUsage: null,
    model: null,
    ...overrides,
  }
}

describe("isNearTop", () => {
  it("is true when within the trigger distance of the top", () => {
    expect(isNearTop(0, 800)).toBe(true)
    expect(isNearTop(800 * NEAR_TOP_VIEWPORTS - 1, 800)).toBe(true)
  })

  it("is false beyond the trigger distance", () => {
    expect(isNearTop(800 * NEAR_TOP_VIEWPORTS, 800)).toBe(false)
    expect(isNearTop(10000, 800)).toBe(false)
  })

  it("is false for a hidden container", () => {
    expect(isNearTop(0, 0)).toBe(false)
  })
})

describe("shouldShowEmptyState", () => {
  it("shows the empty state once history is exhausted", () => {
    expect(shouldShowEmptyState(0, false)).toBe(true)
  })

  it("keeps the list mounted while older pages remain", () => {
    // The empty state renders no scroll content, so nothing would be left to
    // trigger a page load — a window that parsed to zero turns would strand
    // the session there permanently.
    expect(shouldShowEmptyState(0, true)).toBe(false)
  })

  it("never shows the empty state when there are turns", () => {
    expect(shouldShowEmptyState(3, true)).toBe(false)
    expect(shouldShowEmptyState(3, false)).toBe(false)
  })
})

describe("isPrepend", () => {
  it("detects items inserted at the front", () => {
    expect(isPrepend({ firstKey: "b", length: 2 }, ["a", "b", "c"])).toBe(true)
  })

  it("is false on first render", () => {
    expect(isPrepend(null, ["a"])).toBe(false)
    expect(isPrepend({ firstKey: undefined, length: 0 }, ["a"])).toBe(false)
  })

  it("is false for appends", () => {
    expect(isPrepend({ firstKey: "a", length: 2 }, ["a", "b", "c"])).toBe(false)
  })

  it("is false when the list shrank or stayed the same size (filtering)", () => {
    expect(isPrepend({ firstKey: "b", length: 3 }, ["a", "c"])).toBe(false)
    expect(isPrepend({ firstKey: "b", length: 2 }, ["a", "c"])).toBe(false)
  })

  it("is false when the previous first item disappeared (replacement)", () => {
    expect(isPrepend({ firstKey: "x", length: 1 }, ["a", "b", "c"])).toBe(false)
  })
})

describe("prependTurns", () => {
  it("prepends older turns before existing ones", () => {
    const existing = [makeTurn("c"), makeTurn("d")]
    const result = prependTurns(existing, [makeTurn("a"), makeTurn("b")])
    expect(result.map((t) => t.id)).toEqual(["a", "b", "c", "d"])
  })

  it("deduplicates by turn id", () => {
    const existing = [makeTurn("b"), makeTurn("c")]
    const result = prependTurns(existing, [makeTurn("a"), makeTurn("b")])
    expect(result.map((t) => t.id)).toEqual(["a", "b", "c"])
    // The existing copy wins
    expect(result[1]).toBe(existing[0])
  })

  it("returns the existing array by reference when nothing to prepend", () => {
    const existing = [makeTurn("a")]
    expect(prependTurns(existing, [makeTurn("a")])).toBe(existing)
    expect(prependTurns(existing, [])).toBe(existing)
  })

  it("stitches a boundary-cut turn back together for Claude sessions", () => {
    // The tail started mid-turn: its first fragment has no user message.
    const newerFragment = makeTurn("synthetic-assistant-uuid", {
      userMessage: null,
      assistantText: ["...rest of the answer"],
      durationMs: 1234,
      model: "opus",
    })
    const olderFragment = makeTurn("user-uuid", {
      assistantText: ["start of the answer"],
    })
    const result = prependTurns(
      [newerFragment, makeTurn("next")],
      [makeTurn("prev"), olderFragment],
      "claude",
    )

    // The stitched turn keeps the on-screen fragment's id so the rendered row
    // (and prepend detection) survive the merge.
    expect(result.map((t) => t.id)).toEqual(["prev", "synthetic-assistant-uuid", "next"])
    const stitched = result[1]
    expect(stitched.userMessage).toBe("msg-user-uuid")
    expect(stitched.assistantText).toEqual(["start of the answer", "...rest of the answer"])
    expect(stitched.durationMs).toBe(1234)
    expect(stitched.model).toBe("opus")
  })

  it("spans the stitched turn's duration across both fragments", () => {
    const newer = makeTurn("n", {
      userMessage: null,
      timestamp: "2026-07-23T10:05:00.000Z",
      durationMs: 30_000,
    })
    const older = makeTurn("o", { timestamp: "2026-07-23T10:00:00.000Z", durationMs: 60_000 })
    const [stitched] = prependTurns([newer], [older], "claude")
    expect(stitched.durationMs).toBe(330_000)
  })

  it("keeps the newer fragment's compaction summary only when the older has none", () => {
    const newer = makeTurn("n", { userMessage: null, compactionSummary: "newer" })
    const older = makeTurn("o", { compactionSummary: "older" })
    const [stitched] = prependTurns([newer], [older], "claude")
    expect(stitched.compactionSummary).toBe("older")

    const olderBare = makeTurn("o2")
    const [stitched2] = prependTurns([newer], [olderBare], "claude")
    expect(stitched2.compactionSummary).toBe("newer")
  })

  it("leaves a whole Codex turn alone (null userMessage is normal there)", () => {
    const existing = [makeTurn("b", { userMessage: null })]
    const result = prependTurns(existing, [makeTurn("a", { userMessage: null })], "codex")
    expect(result.map((t) => t.id)).toEqual(["a", "b"])
    expect(result[1]).toBe(existing[0])
  })

  it("stitches a Codex turn the parser flagged as a cut fragment", () => {
    const head = makeTurn("frag", { userMessage: null, isFragment: true, assistantText: ["end"] })
    const older = makeTurn("a", { assistantText: ["start"] })
    const result = prependTurns([head], [older], "codex")
    expect(result).toHaveLength(1)
    expect(result[0].userMessage).toBe(older.userMessage)
    expect(result[0].assistantText).toEqual(["start", "end"])
  })

  it("chain-stitches when both fragments lack a user message", () => {
    // Two consecutive cuts inside one giant turn.
    const head = makeTurn("frag2", { userMessage: null, assistantText: ["end"] })
    const mid = makeTurn("frag1", { userMessage: null, assistantText: ["middle"] })
    const [stitched] = prependTurns([head], [mid], "claude")
    expect(stitched.id).toBe("frag2")
    expect(stitched.userMessage).toBeNull()
    expect(stitched.assistantText).toEqual(["middle", "end"])
  })
})

// ── Agent mail across a page stitch ──────────────────────────────────────────
//
// `useSessionPaging` parses every page with its own `parseSession` call and
// joins them here, so anything `buildTurns` reconciles within one parse — reply
// pairing, and the enqueue/attachment ledger — sees only that page. These tests
// mirror that: two chunks parsed separately, then stitched.

function agentMessages(turns: readonly Turn[]) {
  return turns.flatMap((turn) =>
    turn.contentBlocks.filter(
      (b): b is Extract<TurnContentBlock, { kind: "agent_message" }> => b.kind === "agent_message"
    )
  )
}

const sendMessage = (to: string, summary: string, id: string) =>
  toolUseAssistant("SendMessage", { to, summary, message: "..." }, id)

describe("prependTurns — agent mail across pages", () => {
  beforeEach(() => {
    resetFixtureCounter()
  })

  it("pairs a message with the reply that landed in a newer page", () => {
    // Observed on `…honest-cms/ddb6fc34….jsonl` at count=30: the
    // certified-status-fix message pages in three pages up from the reply sent
    // 22 seconds later, and the card read "Never answered".
    const older = parseSession(toJsonl([
      userMsg("start"),
      textAssistant("working"),
      peerAttachment("certified-status-fix", "one blocking question on the type error"),
      textAssistant("done"),
    ])).turns
    const newer = parseSession(toJsonl([
      userMsg("next"),
      sendMessage("certified-status-fix", "Fixed the type error you flagged", "sm-1"),
      textAssistant("sent"),
    ])).turns

    expect(agentMessages(older)[0].reply).toBeUndefined()

    const merged = prependTurns(newer, older, "claude")
    expect(agentMessages(merged)[0].reply?.summary).toBe("Fixed the type error you flagged")
  })

  it("does not pair a SendMessage a page boundary left before its sender's message", () => {
    // Re-pairing over the merged list must still only run forward in time:
    // an instruction sent before the agent wrote back is not a reply to it.
    const older = parseSession(toJsonl([
      userMsg("start"),
      sendMessage("vehicle-batch", "go do batch 2", "sm-1"),
      textAssistant("sent"),
    ])).turns
    const newer = parseSession(toJsonl([
      userMsg("next"),
      textAssistant("working"),
      peerAttachment("vehicle-batch", "half-blocked on a decision"),
      textAssistant("done"),
    ])).turns

    const merged = prependTurns(newer, older, "claude")
    expect(agentMessages(merged)[0].reply).toBeUndefined()
  })

  it("keeps a pairing the older page had already made", () => {
    const older = parseSession(toJsonl([
      userMsg("start"),
      textAssistant("working"),
      peerAttachment("vehicle-batch", "half-blocked on a decision"),
      sendMessage("vehicle-batch", "unblocked you", "sm-1"),
      textAssistant("done"),
    ])).turns
    const newer = parseSession(toJsonl([
      userMsg("next"),
      textAssistant("unrelated"),
    ])).turns

    const merged = prependTurns(newer, older, "claude")
    expect(agentMessages(merged)[0].reply?.summary).toBe("unblocked you")
  })

  it("re-pairs the same way however the pages split", () => {
    const pageC = parseSession(toJsonl([
      userMsg("start"),
      textAssistant("working"),
      peerAttachment("w", "first"),
      textAssistant("done"),
    ])).turns
    const pageB = parseSession(toJsonl([
      userMsg("second page"),
      textAssistant("working"),
      peerAttachment("w", "second"),
      sendMessage("w", "re first", "sm-1"),
      textAssistant("done"),
    ])).turns
    const pageA = parseSession(toJsonl([
      userMsg("newest"),
      sendMessage("w", "re second", "sm-2"),
      textAssistant("sent"),
    ])).turns

    const merged = prependTurns(prependTurns(pageA, pageB, "claude"), pageC, "claude")
    expect(agentMessages(merged).map((b) => b.body)).toEqual(["first", "second"])
    expect(agentMessages(merged).map((b) => b.reply?.summary)).toEqual(["re first", "re second"])
  })

  it("renders one card when the enqueue and the attachment land in different pages", () => {
    // The two persisted copies of one message reconcile through a ledger scoped
    // to a single `buildTurns` call, so a page boundary between them leaves both
    // standing — two identical cards reading as two unanswered questions.
    const sender = "csp-and-proxy"
    const body = "one blocking question on finding #1."
    const older = parseSession(toJsonl([
      userMsg("start"),
      textAssistant("working"),
      peerEnqueueMsg(sender, body),
      textAssistant("done"),
    ])).turns
    const newer = parseSession(toJsonl([
      userMsg("next"),
      textAssistant("working"),
      peerAttachment(sender, body),
      textAssistant("done"),
    ])).turns

    expect(agentMessages(older)).toHaveLength(1)
    expect(agentMessages(newer)).toHaveLength(1)

    const merged = prependTurns(newer, older, "claude")
    const blocks = agentMessages(merged)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].sender).toBe(sender)
    expect(blocks[0].body).toBe(body)
  })

  it("keeps two different messages from one sender that split across pages", () => {
    // Same sender, same sender task id, different messages: the dedup key is
    // (sender, body), never the task id.
    const older = parseSession(toJsonl([
      userMsg("start"),
      textAssistant("working"),
      peerAttachment("csp-and-proxy", "one blocking question", "ada0f1591dbec7898"),
      textAssistant("done"),
    ])).turns
    const newer = parseSession(toJsonl([
      userMsg("next"),
      textAssistant("working"),
      peerAttachment("csp-and-proxy", "batch-2 done", "ada0f1591dbec7898"),
      textAssistant("done"),
    ])).turns

    const merged = prependTurns(newer, older, "claude")
    expect(agentMessages(merged).map((b) => b.body)).toEqual([
      "one blocking question",
      "batch-2 done",
    ])
  })
})
