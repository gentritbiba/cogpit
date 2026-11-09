import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { AgentsPanel } from "../AgentsPanel"
import { type SessionView, EMPTY_SESSION_DIGEST } from "../../../../shared/session/sessionDigest"

function makeSession(): SessionView {
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
    digest: EMPTY_SESSION_DIGEST,
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
        canStop
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

  it.each([true, false])("offers to stop a running background agent only when allowed (%s)", (canStop) => {
    render(
      <AgentsPanel
        session={makeSession()}
        sessionSource={{ dirName: "project", fileName: "main-session.jsonl" }}
        bgAgents={[{
          agentId: "bg-1",
          dirName: "project",
          fileName: "main-session/subagents/agent-bg-1.jsonl",
          parentSessionId: "main-session",
          modifiedAt: 1,
          isActive: true,
          preview: "Watching the build",
        }]}
        canStop={canStop}
      />,
    )

    expect(screen.queryByRole("button", { name: /^Stop / }) !== null).toBe(canStop)
  })

  it("indents an agent another agent launched beneath its parent", () => {
    const session = makeSession()
    const block = session.turns[0].contentBlocks[0]
    if (block.kind !== "sub_agent") throw new Error("fixture")
    block.messages.push({
      ...block.messages[0],
      agentId: "a0000inner000000",
      parentAgentId: "ad663a1cf11922085",
      parentToolUseId: "tool-inner",
      agentName: null,
      prompt: "Nested check",
    })

    render(
      <AgentsPanel
        session={session}
        sessionSource={{ dirName: "project", fileName: "main-session.jsonl" }}
        bgAgents={[]}
        canStop
        onLoadSession={vi.fn()}
      />,
    )

    const previews = screen.getAllByText(/Build the E2E|Nested check/).map((node) => node.textContent)
    expect(previews).toEqual(["Build the E2E sim harness for the project", "Nested check"])
    expect(screen.getByText("Nested check").closest(".motion-list-item")).toHaveClass("pl-4")
  })
})
