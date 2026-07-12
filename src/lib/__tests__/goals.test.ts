import { describe, expect, it } from "vitest"
import { extractClaudeGoalState } from "@/lib/goals"

describe("extractClaudeGoalState", () => {
  it("returns the latest active goal and evaluator progress", () => {
    expect(extractClaudeGoalState([
      { type: "attachment", attachment: { type: "goal_status", sentinel: true, met: false, condition: "tests pass" } },
      { type: "attachment", attachment: { type: "goal_status", met: false, condition: "tests pass", reason: "lint still fails", iterations: 2, durationMs: 90_000, tokens: 12_345 } },
    ])).toEqual({
      condition: "tests pass",
      status: "active",
      reason: "lint still fails",
      iterations: 2,
      durationMs: 90_000,
      tokens: 12_345,
    })
  })

  it("distinguishes achieved and failed evaluations", () => {
    expect(extractClaudeGoalState([
      { type: "attachment", attachment: { type: "goal_status", met: true, condition: "ship", iterations: 3 } },
    ])?.status).toBe("achieved")
    expect(extractClaudeGoalState([
      { type: "attachment", attachment: { type: "goal_status", failed: true, condition: "ship" } },
    ])?.status).toBe("failed")
  })

  it("treats Claude's met sentinel as an explicit clear boundary", () => {
    expect(extractClaudeGoalState([
      { type: "attachment", attachment: { type: "goal_status", met: false, condition: "old goal" } },
      { type: "attachment", attachment: { type: "goal_status", sentinel: true, met: true, condition: "old goal" } },
    ])).toBeNull()
  })
})
