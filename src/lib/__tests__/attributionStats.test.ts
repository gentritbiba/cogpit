import { describe, expect, it } from "vitest"
import {
  UNATTRIBUTED_BUCKET,
  aggregateAttribution,
  attributedDimensions,
} from "../../../shared/session/attributionStats"
import type { MessageAttribution, TokenUsage, Turn } from "../types"

let turnCounter = 0

function turn(options: {
  attribution?: MessageAttribution
  usage?: TokenUsage | null
}): Turn {
  turnCounter += 1
  return {
    id: `turn-${turnCounter}`,
    userMessage: null,
    contentBlocks: [],
    thinking: [],
    assistantText: [],
    toolCalls: [],
    subAgentActivity: [],
    timestamp: "2026-08-25T00:00:00.000Z",
    durationMs: null,
    tokenUsage: options.usage === undefined ? { input_tokens: 0, output_tokens: 0 } : options.usage,
    model: "claude-opus-5",
    attribution: options.attribution,
  }
}

describe("aggregateAttribution", () => {
  it("totals tokens and turn counts per skill", () => {
    const turns = [
      turn({ attribution: { skill: "commit" }, usage: { input_tokens: 10, output_tokens: 5 } }),
      turn({ attribution: { skill: "commit" }, usage: { input_tokens: 20, output_tokens: 5 } }),
      turn({ attribution: { skill: "qa" }, usage: { input_tokens: 1, output_tokens: 1 } }),
    ]

    expect(aggregateAttribution(turns, "skill")).toEqual([
      { name: "commit", turns: 2, inputTokens: 30, outputTokens: 10, isUnattributed: false },
      { name: "qa", turns: 1, inputTokens: 1, outputTokens: 1, isUnattributed: false },
    ])
  })

  it("sorts by total tokens descending, not by turn count", () => {
    const turns = [
      turn({ attribution: { agent: "Explore" }, usage: { input_tokens: 1, output_tokens: 1 } }),
      turn({ attribution: { agent: "Explore" }, usage: { input_tokens: 1, output_tokens: 1 } }),
      turn({ attribution: { agent: "implementer" }, usage: { input_tokens: 500, output_tokens: 500 } }),
    ]

    expect(aggregateAttribution(turns, "agent").map((bucket) => bucket.name)).toEqual([
      "implementer",
      "Explore",
    ])
  })

  it("counts cache reads and cache writes as input tokens, matching InputOutputChart", () => {
    const turns = [
      turn({
        attribution: { skill: "commit" },
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          cache_read_input_tokens: 1_000,
          cache_creation_input_tokens: 200,
        },
      }),
    ]

    expect(aggregateAttribution(turns, "skill")).toEqual([
      { name: "commit", turns: 1, inputTokens: 1_210, outputTokens: 4, isUnattributed: false },
    ])
  })

  it("counts a turn with no token usage as a turn with zero tokens", () => {
    const turns = [
      turn({ attribution: { skill: "commit" }, usage: null }),
      turn({ attribution: { skill: "commit" }, usage: { input_tokens: 7, output_tokens: 3 } }),
    ]

    expect(aggregateAttribution(turns, "skill")).toEqual([
      { name: "commit", turns: 2, inputTokens: 7, outputTokens: 3, isUnattributed: false },
    ])
  })

  it("groups turns with no value for the dimension into one bucket, pinned last", () => {
    const turns = [
      turn({ usage: { input_tokens: 5_000, output_tokens: 5_000 } }),
      turn({ attribution: { agent: "Explore" }, usage: { input_tokens: 5_000, output_tokens: 5_000 } }),
      turn({ attribution: { skill: "commit" }, usage: { input_tokens: 10, output_tokens: 2 } }),
    ]

    expect(aggregateAttribution(turns, "skill")).toEqual([
      { name: "commit", turns: 1, inputTokens: 10, outputTokens: 2, isUnattributed: false },
      {
        name: UNATTRIBUTED_BUCKET,
        turns: 2,
        inputTokens: 10_000,
        outputTokens: 10_000,
        isUnattributed: true,
      },
    ])
  })

  it("omits the unattributed bucket when every turn carries the dimension", () => {
    const turns = [turn({ attribution: { mcpServer: "clickup" } })]

    expect(aggregateAttribution(turns, "mcpServer")).toEqual([
      { name: "clickup", turns: 1, inputTokens: 0, outputTokens: 0, isUnattributed: false },
    ])
  })

  it("reads each dimension independently off the same turn", () => {
    const turns = [
      turn({
        attribution: { agent: "general-purpose", mcpServer: "clickup", mcpTool: "clickup_get_task" },
        usage: { input_tokens: 2, output_tokens: 1 },
      }),
    ]

    expect(aggregateAttribution(turns, "mcpTool")[0].name).toBe("clickup_get_task")
    expect(aggregateAttribution(turns, "agent")[0].name).toBe("general-purpose")
    expect(aggregateAttribution(turns, "plugin")[0].isUnattributed).toBe(true)
  })

  it("returns nothing for an empty transcript", () => {
    expect(aggregateAttribution([], "skill")).toEqual([])
  })
})

describe("attributedDimensions", () => {
  it("lists only the dimensions some turn was attributed to, in a fixed order", () => {
    const turns = [
      turn({ attribution: { mcpTool: "clickup_get_task", mcpServer: "clickup" } }),
      turn({ attribution: { skill: "commit" } }),
      turn({}),
    ]

    expect(attributedDimensions(turns)).toEqual(["skill", "mcpServer", "mcpTool"])
  })

  it("is empty when no turn carries attribution", () => {
    expect(attributedDimensions([turn({}), turn({})])).toEqual([])
  })
})
