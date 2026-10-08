import { describe, expect, it } from "vitest"
import { formatTaskWakeup } from "../../../shared/contracts/taskWakeup"
import { taskWakeupSummary } from "../userMessageContent"

const wakeup = (state: "completed" | "error", files: number) => formatTaskWakeup({
  id: "task-1",
  parentSessionId: "coordinator",
  childSessionId: "lane",
  state,
  result: { turn: { reply: "PR #252 is merged" }, filesChanged: Array.from({ length: files }, (_, i) => ({ path: `f${i}` })) },
})

describe("taskWakeupSummary", () => {
  it("names the session that finished and how many files it changed", () => {
    const nameOf = (id: string) => (id === "lane" ? "w3-ops-tooling" : undefined)
    expect(taskWakeupSummary(wakeup("completed", 44), nameOf)).toBe("w3-ops-tooling finished · 44 files changed")
    expect(taskWakeupSummary(wakeup("error", 1), nameOf)).toBe("w3-ops-tooling failed · 1 file changed")
    expect(taskWakeupSummary(wakeup("completed", 0), nameOf)).toBe("w3-ops-tooling finished")
  })

  it("falls back to a generic line for a session it cannot name, and ignores other prompts", () => {
    expect(taskWakeupSummary(wakeup("completed", 3))).toBe("Delegated session finished")
    expect(taskWakeupSummary(wakeup("error", 3), () => undefined)).toBe("Delegated session failed")
    expect(taskWakeupSummary("Fix the tests", () => "x")).toBeNull()
  })
})
