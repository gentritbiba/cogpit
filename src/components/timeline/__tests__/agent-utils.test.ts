import { describe, expect, it } from "vitest"
import type { SubAgentMessage } from "@/lib/types"
import { buildParentToolByAgent } from "../agent-utils"

function msg(agentId: string, parentToolUseId?: string): SubAgentMessage {
  return { agentId, parentToolUseId, text: [] } as unknown as SubAgentMessage
}

describe("buildParentToolByAgent", () => {
  it("maps each agent to its Task tool call", () => {
    const map = buildParentToolByAgent([msg("a1", "tool-1"), msg("a2", "tool-2")])

    expect(map.get("a1")).toBe("tool-1")
    expect(map.get("a2")).toBe("tool-2")
  })

  it("keeps the first tool id seen for an agent", () => {
    const map = buildParentToolByAgent([msg("a1", "tool-1"), msg("a1", "tool-9")])

    expect(map.get("a1")).toBe("tool-1")
  })

  it("skips messages with no tool id", () => {
    const map = buildParentToolByAgent([msg("a1"), msg("a2", "tool-2")])

    expect(map.has("a1")).toBe(false)
    expect(map.get("a2")).toBe("tool-2")
  })

  it("drops a tool id claimed by several agents rather than replaying one stream under all of them", () => {
    const map = buildParentToolByAgent([
      msg("a1", "shared"),
      msg("a2", "shared"),
      msg("a3", "shared"),
      msg("a4", "tool-own"),
    ])

    expect(map.has("a1")).toBe(false)
    expect(map.has("a2")).toBe(false)
    expect(map.has("a3")).toBe(false)
    // Correctly attributed siblings are untouched.
    expect(map.get("a4")).toBe("tool-own")
  })
})
