import { describe, it, expect } from "vitest"
import { getToolSummary } from "../ToolCallCard"
import type { ToolCall } from "@/lib/types"

function makeToolCall(name: string, input: Record<string, unknown>): ToolCall {
  return {
    id: "test-id",
    name,
    input,
    result: null,
    isError: false,
    timestamp: new Date().toISOString(),
  }
}

describe("getToolSummary", () => {
  it("Monitor: returns bash_id and filter", () => {
    expect(getToolSummary(makeToolCall("Monitor", { bash_id: "abc", filter: "ERROR" }))).toBe("abc · filter=ERROR")
  })

  it("Monitor: returns bash_id without filter when filter is absent", () => {
    expect(getToolSummary(makeToolCall("Monitor", { bash_id: "abc" }))).toBe("abc")
  })

  it("CronCreate: returns schedule arrow prompt", () => {
    expect(getToolSummary(makeToolCall("CronCreate", { schedule: "0 */6 * * *", prompt: "/babysit-prs" }))).toBe("0 */6 * * * → /babysit-prs")
  })

  it("CronList: returns empty string", () => {
    expect(getToolSummary(makeToolCall("CronList", {}))).toBe("")
  })

  it("CronDelete: returns id", () => {
    expect(getToolSummary(makeToolCall("CronDelete", { id: "cron_123" }))).toBe("cron_123")
  })

  it("ScheduleWakeup: returns human-friendly delay and reason", () => {
    expect(getToolSummary(makeToolCall("ScheduleWakeup", { delaySeconds: 1800, reason: "polling deploy" }))).toBe("in 30m · polling deploy")
  })

  it("ScheduleWakeup: formats hours correctly", () => {
    expect(getToolSummary(makeToolCall("ScheduleWakeup", { delaySeconds: 3600, reason: "hourly check" }))).toBe("in 1h · hourly check")
  })

  it("ScheduleWakeup: formats seconds correctly", () => {
    expect(getToolSummary(makeToolCall("ScheduleWakeup", { delaySeconds: 45, reason: "quick poll" }))).toBe("in 45s · quick poll")
  })

  it("RemoteTrigger: returns action and id", () => {
    expect(getToolSummary(makeToolCall("RemoteTrigger", { action: "run", id: "trig_42" }))).toBe("run trig_42")
  })

  it("PushNotification: returns title", () => {
    expect(getToolSummary(makeToolCall("PushNotification", { title: "Build done", body: "..." }))).toBe("Build done")
  })

  it("EnterWorktree: returns name with path", () => {
    expect(getToolSummary(makeToolCall("EnterWorktree", { name: "fix-auth", branch: "feat/auth", path: "/x/y" }))).toBe("fix-auth (/x/y)")
  })

  it("ExitWorktree: returns name", () => {
    expect(getToolSummary(makeToolCall("ExitWorktree", { name: "fix-auth" }))).toBe("fix-auth")
  })

  it("Skill: returns skill name", () => {
    expect(getToolSummary(makeToolCall("Skill", { skill: "commit", args: "" }))).toBe("commit")
  })

  it("ToolSearch: returns query", () => {
    expect(getToolSummary(makeToolCall("ToolSearch", { query: "select:Read", max_results: 5 }))).toBe("select:Read")
  })
})
