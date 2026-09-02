import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { ParsedSession } from "../../../../shared/session/types"
import { AgentsPanel } from "../AgentsPanel"

function makeSession(): ParsedSession {
  return {
    sessionId: "main-session",
    version: "2.1.198",
    gitBranch: "main",
    cwd: "/tmp/project",
    slug: "project",
    name: "main",
    model: "claude-fable-5",
    turns: [{
      id: "turn-1",
      userMessage: "Build the harness",
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
          prompt: "Build the E2E sim harness for the project",
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
    }],
    stats: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      toolCallCounts: {},
      errorCount: 0,
      totalDurationMs: 0,
      turnCount: 1,
    },
    rawMessages: [],
    agentKind: "claude",
  }
}

describe("AgentsPanel", () => {
  it("keeps agent context in the stats panel and opens its transcript", () => {
    const onLoadSession = vi.fn()

    render(
      <AgentsPanel
        session={makeSession()}
        sessionSource={{ dirName: "project", fileName: "main-session.jsonl" }}
        bgAgents={[]}
        onLoadSession={onLoadSession}
      />,
    )

    expect(screen.getByText("Agents (1)")).toBeInTheDocument()
    expect(screen.getByText("Build the E2E sim harness for the project")).toBeInTheDocument()
    expect(screen.getByText("done")).toBeInTheDocument()
    expect(screen.getByText("12s")).toBeInTheDocument()
    expect(screen.getByText("8 tools")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: /sim-harness/i }))
    expect(onLoadSession).toHaveBeenCalledWith(
      "project",
      "main-session/subagents/agent-ad663a1cf11922085.jsonl",
    )
  })
})
