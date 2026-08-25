import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { TurnSection } from "../TurnSection"
import type { ParsedSession, ToolCall, Turn } from "@/lib/types"

const mocks = vi.hoisted(() => ({
  status: "thinking" as "thinking" | "completed",
}))

vi.mock("@/contexts/AppContext", () => ({
  useAppContext: () => ({
    state: { activeTurnIndex: 0, activeToolCallId: "question-1", expandAll: false },
    isMobile: false,
  }),
}))

vi.mock("@/contexts/SessionContext", () => ({
  useSessionContext: () => ({
    session: makeSession(),
    isLive: true,
    isSubAgentView: false,
    undoRedo: { enabled: false },
    actions: {},
  }),
}))

vi.mock("@/hooks/useNearViewport", () => ({
  useNearViewport: () => ({ ref: { current: null }, isNear: true }),
}))

vi.mock("@/hooks/useSkillMetadata", () => ({
  useSkillMetadata: () => new Map(),
}))

vi.mock("@/lib/sessionStatus", () => ({
  deriveSessionStatus: () => ({ status: mocks.status }),
}))

vi.mock("../AgentStatusIndicator", () => ({
  LiveElapsed: () => <span>elapsed</span>,
}))

vi.mock("../AssistantText", () => ({
  AssistantText: ({ text }: { text: string }) => <div>{text}</div>,
}))

vi.mock("../CollapsibleToolCalls", () => ({
  CollapsibleToolCalls: ({ toolCalls }: { toolCalls: ToolCall[] }) => (
    <div>{toolCalls.map((toolCall) => toolCall.name).join(", ")}</div>
  ),
}))

const question: ToolCall = {
  id: "question-1",
  name: "AskUserQuestion",
  input: {},
  result: null,
  isError: false,
  timestamp: "2026-08-19T12:00:01.000Z",
}

const turn: Turn = {
  id: "turn-1",
  userMessage: null,
  contentBlocks: [
    { kind: "text", text: ["Streaming response"] },
    { kind: "tool_calls", toolCalls: [question] },
    { kind: "text", text: ["Final response"] },
  ],
  thinking: [],
  assistantText: ["Streaming response", "Final response"],
  toolCalls: [question],
  subAgentActivity: [],
  timestamp: "2026-08-19T12:00:00.000Z",
  durationMs: null,
  tokenUsage: null,
  model: null,
}

/** A turn the agent ended on an open question — nothing follows the prompt. */
const blockedTurn: Turn = {
  ...turn,
  id: "turn-blocked",
  contentBlocks: [
    { kind: "text", text: ["Which is my one question for now:"] },
    { kind: "tool_calls", toolCalls: [question] },
  ],
  assistantText: ["Which is my one question for now:"],
}

/** A completed turn whose work would fold, carrying a peer agent's message. */
const mailTurn: Turn = {
  ...turn,
  id: "turn-mail",
  contentBlocks: [
    { kind: "tool_calls", toolCalls: [question] },
    {
      kind: "agent_message",
      sender: "csp-and-proxy",
      body: "One blocking question on finding #1.",
      timestamp: "2026-08-19T12:00:02.000Z",
    },
    { kind: "text", text: ["Final response"] },
  ],
  assistantText: ["Final response"],
}

function makeSession(): ParsedSession {
  return {
    sessionId: "session-1",
    version: "1.0",
    gitBranch: "",
    cwd: "/workspace",
    slug: "test",
    name: "",
    model: "",
    turns: [turn],
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
  }
}

describe("TurnSection work disclosure", () => {
  beforeEach(() => {
    mocks.status = "thinking"
  })

  it("keeps active streaming output and pending tool interactions open by default", () => {
    render(<TurnSection turn={turn} index={0} />)

    expect(screen.getByRole("button", { name: /working for/i })).toHaveAttribute(
      "aria-expanded",
      "true",
    )
    expect(screen.getByText("Streaming response")).toBeInTheDocument()
    expect(screen.getByText("AskUserQuestion")).toBeInTheDocument()
  })

  it("keeps a turn-ending unanswered prompt visible after the turn settles", () => {
    // A question-blocked session emits no traffic, so the stream goes quiet and
    // the turn reads as completed. Folding it away leaves the status line saying
    // "Waiting for your answer" with no answer form anywhere on screen.
    mocks.status = "completed"

    render(<TurnSection turn={blockedTurn} index={0} />)

    expect(screen.getByText("AskUserQuestion")).toBeInTheDocument()
  })

  it("still folds completed work by default", () => {
    mocks.status = "completed"

    render(<TurnSection turn={turn} index={0} />)

    expect(screen.getByRole("button", { name: /worked for/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    )
    expect(screen.queryByText("Streaming response")).not.toBeInTheDocument()
    expect(screen.queryByText("AskUserQuestion")).not.toBeInTheDocument()
    expect(screen.getByText("Final response")).toBeInTheDocument()
  })
})

describe("TurnSection agent messages", () => {
  it("renders a peer message as a card naming its sender", () => {
    mocks.status = "completed"

    render(<TurnSection turn={mailTurn} index={0} />)

    expect(screen.getByText("csp-and-proxy")).toBeInTheDocument()
    expect(screen.getByText("One blocking question on finding #1.")).toBeInTheDocument()
  })
})
