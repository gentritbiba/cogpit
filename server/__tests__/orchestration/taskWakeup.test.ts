import { describe, expect, it } from "vitest"
import { formatTaskWakeup, isTaskWakeup, parseTaskWakeup } from "../../../shared/contracts/taskWakeup"

const task = { id: "task-1", parentSessionId: "parent", childSessionId: "child", state: "completed" as const }

describe("task wakeup", () => {
  it("reads back the result it was written with", () => {
    const result = { turn: { reply: "Done.\nAll green." }, filesChanged: [{ path: "a.ts" }] }
    expect(parseTaskWakeup(formatTaskWakeup({ ...task, result }))).toEqual({ taskId: "task-1", state: "completed", childSessionId: "child", result })
  })

  it("keeps a result cut to fit as text", () => {
    const parsed = parseTaskWakeup(formatTaskWakeup({ ...task, state: "error", result: { reply: "x".repeat(30000) } }))
    expect(parsed?.state).toBe("error")
    expect(typeof parsed?.result).toBe("string")
  })

  it("ignores ordinary prompts", () => {
    expect(parseTaskWakeup("Delegated task looks fine, carry on")).toBeNull()
    expect(isTaskWakeup("Delegated task looks fine, carry on")).toBe(false)
  })

  it("recognizes a wakeup from its opening alone", () => {
    expect(isTaskWakeup(formatTaskWakeup({ ...task, result: null }).slice(0, 120))).toBe(true)
  })
})
