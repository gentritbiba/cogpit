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
      totalCostUSD: 0,
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
