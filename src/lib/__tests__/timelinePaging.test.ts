import { describe, it, expect } from "vitest"
import { isNearTop, isPrepend, prependTurns, NEAR_TOP_VIEWPORTS } from "@/lib/timelinePaging"
import type { Turn } from "@/lib/types"

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

  it("keeps the newer fragment's compaction summary only when the older has none", () => {
    const newer = makeTurn("n", { userMessage: null, compactionSummary: "newer" })
    const older = makeTurn("o", { compactionSummary: "older" })
    const [stitched] = prependTurns([newer], [older], "claude")
    expect(stitched.compactionSummary).toBe("older")

    const olderBare = makeTurn("o2")
    const [stitched2] = prependTurns([newer], [olderBare], "claude")
    expect(stitched2.compactionSummary).toBe("newer")
  })

  it("never stitches Codex turns (null userMessage is normal there)", () => {
    const existing = [makeTurn("b", { userMessage: null })]
    const result = prependTurns(existing, [makeTurn("a", { userMessage: null })], "codex")
    expect(result.map((t) => t.id)).toEqual(["a", "b"])
    expect(result[1]).toBe(existing[0])
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
