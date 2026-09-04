import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { TurnSection } from "../TurnSection"
import type { ParsedSession, ToolCall, Turn } from "../../../../shared/session/types"

const mocks = vi.hoisted(() => ({
  status: "thinking" as "thinking" | "completed",
  isLive: true,
  undoEnabled: false,
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
    isLive: mocks.isLive,
    isSubAgentView: false,
    undoRedo: mocks.undoEnabled
      ? { enabled: true, requestUndo: vi.fn(), branchesAtTurn: () => [] }
      : { enabled: false },
    actions: mocks.undoEnabled
      ? { handleOpenBranches: vi.fn(), handleBranchFromHere: vi.fn() }
      : {},
  }),
}))

vi.mock("@/hooks/useNearViewport", () => ({
  useNearViewport: () => ({ ref: { current: null }, isNear: true }),
}))

vi.mock("@/hooks/useSkillMetadata", () => ({
  useSkillMetadata: () => new Map(),
}))

vi.mock("../../../../shared/session/sessionStatus", () => ({
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
  beforeEach(() => {
    mocks.isLive = true
  })

  it("renders a peer message as a card naming its sender", () => {
    mocks.status = "completed"

    render(<TurnSection turn={mailTurn} index={0} />)

    expect(screen.getByText("csp-and-proxy")).toBeInTheDocument()
    expect(screen.getByText("One blocking question on finding #1.")).toBeInTheDocument()
  })

  it("keeps an unanswered peer message waiting while its turn is the live one", () => {
    mocks.status = "thinking"

    render(<TurnSection turn={mailTurn} index={0} />)

    expect(screen.getByText(/Awaiting your reply/i)).toBeInTheDocument()
  })

  it("keeps waiting on an unanswered peer message from an earlier turn", () => {
    mocks.status = "thinking"

    // The mocked session holds one turn, so index 1 sits behind the live one.
    // The wait is a property of the session, not of the turn the message landed
    // in: a question you lost track of several turns ago is still answerable,
    // and is the single most valuable thing this card surfaces.
    render(<TurnSection turn={mailTurn} index={1} />)

    expect(screen.getByText(/Awaiting your reply/i)).toBeInTheDocument()
    expect(screen.queryByText(/Never answered/i)).not.toBeInTheDocument()
  })

  it("settles an unanswered peer message once the session is no longer live", () => {
    mocks.isLive = false
    mocks.status = "completed"

    render(<TurnSection turn={mailTurn} index={0} />)

    expect(screen.getByText(/Never answered/i)).toBeInTheDocument()
    expect(screen.queryByText(/Awaiting your reply/i)).not.toBeInTheDocument()
  })
})

describe("TurnSection prompt context menu", () => {
  beforeEach(() => {
    mocks.isLive = true
    mocks.status = "completed"
    mocks.undoEnabled = true
  })

  const promptTurn: Turn = { ...turn, id: "turn-prompt", userMessage: "Do the thing" }

  const triggerFor = (text: string) =>
    screen.getByText(text).closest("[data-slot='context-menu-trigger']")

  it("hangs the turn actions off the user message", () => {
    render(<TurnSection turn={promptTurn} index={0} />)

    expect(triggerFor("Do the thing")).not.toBeNull()
  })

  it("leaves the rest of the turn to the platform's own context menu", () => {
    render(<TurnSection turn={promptTurn} index={0} />)

    expect(triggerFor("Final response")).toBeNull()
  })

  it("skips redo ghosts, which sit past the last restorable turn", () => {
    // The mocked session holds one turn, so index 1 can only be a ghost.
    render(<TurnSection turn={promptTurn} index={1} />)

    expect(triggerFor("Do the thing")).toBeNull()
  })
})
