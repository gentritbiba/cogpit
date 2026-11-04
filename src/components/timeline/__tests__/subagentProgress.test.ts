import { describe, expect, it } from "vitest"
import { subagentProgress } from "../SpawnedSessionRows"
import type { SubAgentMessage, ToolCall } from "../../../../shared/session/types"
import type { TaskNotification } from "@/lib/userMessageContent"

function call(overrides: Partial<ToolCall> = {}): ToolCall {
  return { id: "call-1", name: "Agent", input: { description: "Map routes" }, result: null, isError: false, timestamp: "2026-11-04T01:00:00.000Z", ...overrides }
}

function activity(status: string, text: string[] = []): SubAgentMessage {
  return {
    agentId: "agent-1", parentToolUseId: "call-1", agentName: null, subagentType: null, type: "assistant",
    content: null, toolCalls: [], thinking: [], text, timestamp: "", tokenUsage: null, model: null, isBackground: false, status,
  }
}

const base = { background: false, isAgentActive: false, isLive: true }

describe("subagentProgress", () => {
  it("keeps an agent whose spawn returned only a receipt working until its activity finishes", () => {
    const receipt = call({ name: "spawn_agent", result: "{\"agent_id\":\"agent-1\"}" })
    expect(subagentProgress({ ...base, toolCall: receipt, activity: activity("running") })).toEqual({ state: "working", reply: "" })
    expect(subagentProgress({ ...base, isLive: false, toolCall: receipt, activity: activity("running") }).state).toBe("started")
    expect(subagentProgress({ ...base, toolCall: receipt, activity: activity("completed", ["Mapped 12 routes"]) })).toEqual({ state: "finished", reply: "Mapped 12 routes" })
    expect(subagentProgress({ ...base, toolCall: receipt, activity: activity("interrupted") }).state).toBe("failed")
  })

  it("shows a launch that failed, even for a background agent", () => {
    const failed = call({ input: { run_in_background: true }, result: "Error: agent type not found", isError: true })
    expect(subagentProgress({ ...base, background: true, toolCall: failed })).toEqual({ state: "failed", reply: "Error: agent type not found" })
  })

  it("waits for a background agent's notification, then reports it", () => {
    const launched = call({ input: { run_in_background: true }, result: "Async agent launched successfully." })
    expect(subagentProgress({ ...base, background: true, toolCall: launched }).state).toBe("working")
    const outcome = { status: "completed", result: "All done" } as TaskNotification
    expect(subagentProgress({ ...base, background: true, toolCall: launched, outcome })).toEqual({ state: "finished", reply: "All done" })
  })

  it("falls back to the call's own result without recorded activity", () => {
    expect(subagentProgress({ ...base, toolCall: call({ result: "Found it\nagentId: abc (resume)" }) })).toEqual({ state: "finished", reply: "Found it" })
    expect(subagentProgress({ ...base, isAgentActive: true, toolCall: call() }).state).toBe("working")
  })
})
