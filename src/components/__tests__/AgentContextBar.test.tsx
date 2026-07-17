import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import type { ParsedSession } from "@/lib/types"
import { AgentContextBar } from "../AgentContextBar"

function makeSession(withAgent = true): ParsedSession {
  return {
    sessionId: "main-session",
    version: "2.1.198",
    gitBranch: "master",
    cwd: "/tmp/ea-agent",
    slug: "ea-agent",
    name: "main",
    model: "claude-fable-5",
    turns: withAgent
      ? [{
          id: "turn-1",
          userMessage: "Build the sim harness",
          contentBlocks: [{
            kind: "sub_agent",
            messages: [{
              agentId: "ad663a1cf11922085",
              parentToolUseId: "tool-1",
              agentName: "sim-harness",
              subagentType: "implementer",
              type: "assistant",
              content: [],
              toolCalls: [],
              thinking: [],
              text: ["Implemented the harness"],
              timestamp: "2026-07-15T01:00:00Z",
              tokenUsage: null,
              model: "claude-fable-5",
              isBackground: false,
              prompt: "Build the E2E sim harness for the ea-agent repo",
              status: "completed",
              durationMs: 12_400,
              toolUseCount: 8,
            }],
          }],
          thinking: [],
          assistantText: [],
          toolCalls: [],
          subAgentActivity: [],
          timestamp: "2026-07-15T01:00:00Z",
          durationMs: null,
          tokenUsage: null,
          model: null,
        }]
      : [],
    stats: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      totalCostUSD: 0,
      toolCallCounts: {},
      errorCount: 0,
      totalDurationMs: 0,
      turnCount: 0,
    },
    rawMessages: [],
    agentKind: "claude",
  }
}

describe("AgentContextBar", () => {
  it("keeps Claude subagents visible and exposes task context", () => {
    const onLoadSession = vi.fn()
    render(
      <AgentContextBar
        session={makeSession()}
        sessionSource={{ dirName: "project", fileName: "main-session.jsonl" }}
        onLoadSession={onLoadSession}
      />
    )

    expect(screen.getByText("sim-harness")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /agents/i }))

    expect(screen.getByText("Build the E2E sim harness for the ea-agent repo")).toBeInTheDocument()
    expect(screen.getByText("done")).toBeInTheDocument()
    expect(screen.getByText("8 tools")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: /open transcript/i }))
    expect(onLoadSession).toHaveBeenCalledWith(
      "project",
      "main-session/subagents/agent-ad663a1cf11922085.jsonl"
    )
  })

  it("does not add a bar to sessions without delegated agents", () => {
    const { container } = render(<AgentContextBar session={makeSession(false)} />)
    expect(container.firstChild).toBeNull()
  })
})
