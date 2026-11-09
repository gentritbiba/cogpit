import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { TurnSection } from "../TurnSection"
import { TimelineRowsProvider } from "../TimelineRowsProvider"
import { revealToolCall, useTimelineStore, type TimelineStateStore } from "../disclosure"
import { EMPTY_SESSION_DIGEST, type SessionView } from "../../../../shared/session/sessionDigest"
import type { SubAgentMessage, ToolCall, Turn } from "../../../../shared/session/types"
import { formatTaskAttention, formatTaskWakeup } from "../../../../shared/contracts/taskWakeup"
import { formatCrewChatDelivery } from "../../../../shared/contracts/crewChat"

const mocks = vi.hoisted(() => ({
  status: "thinking" as "thinking" | "completed",
  isLive: true,
  undoEnabled: false,
  isMobile: false,
  activeToolCallId: null as string | null,
  /** What `useSessionContextOptional` hands rows that look up the open transcript. */
  optionalContext: null as null | { session: { turns: Turn[] }; permissions: { send: boolean }; actions: Record<string, never> },
}))

vi.mock("@/contexts/AppContext", () => ({
  useAppContext: () => ({
    state: { expandAll: false },
    isMobile: mocks.isMobile,
  }),
}))

vi.mock("@/contexts/SessionContext", () => ({
  useSessionContextOptional: () => mocks.optionalContext,
  useSessionContext: () => ({
    session: makeSession(),
    sessionSource: null,
    activeTurnIndex: 0,
    activeToolCallId: mocks.activeToolCallId,
    isLive: mocks.isLive,
    isSubAgentView: false,
    permissions: { send: true, answer: true },
    pendingInteraction: null,
    undoRedo: mocks.undoEnabled
      ? { enabled: true, requestUndo: vi.fn(), branchesAtTurn: () => [], branches: [] }
      : { enabled: false, branches: [] },
    actions: mocks.undoEnabled
      ? { handleOpenBranches: vi.fn(), handleBranchFromHere: vi.fn() }
      : {},
  }),
}))

vi.mock("@/hooks/useSkillMetadata", () => ({
  useSkillMetadata: () => new Map(),
}))

vi.mock("../AgentStatusIndicator", () => ({
  LiveElapsed: () => <span>elapsed</span>,
}))

vi.mock("../AssistantText", () => ({
  AssistantText: ({ text, compact }: { text: string; compact?: boolean }) => <div data-testid="assistant-text" data-compact={String(Boolean(compact))}>{text}</div>,
}))

vi.mock("../AgentPanel", () => ({
  AgentPanel: ({ label }: { label: string }) => <div>{label}</div>,
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

function wrapper({ children }: { children: React.ReactNode }) {
  return <TimelineRowsProvider>{children}</TimelineRowsProvider>
}

function makeSession(): SessionView {
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
    digest: { ...EMPTY_SESSION_DIGEST, status: { status: mocks.status } },
  }
}

describe("TurnSection work disclosure", () => {
  beforeEach(() => {
    mocks.status = "thinking"
    mocks.isMobile = false
    mocks.activeToolCallId = null
  })

  it("keeps desktop response metadata and controls enabled on mobile", () => {
    mocks.isMobile = true
    render(<TurnSection turn={turn} index={0} turnKey="turn" isLast={true} />, { wrapper })
    for (const text of screen.getAllByTestId("assistant-text")) {
      expect(text).toHaveAttribute("data-compact", "false")
    }
  })

  it("keeps active streaming output and pending tool interactions open by default", () => {
    render(<TurnSection turn={turn} index={0} turnKey="turn" isLast={true} />, { wrapper })

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

    render(<TurnSection turn={blockedTurn} index={0} turnKey="turn" isLast={true} />, { wrapper })

    expect(screen.getByText("AskUserQuestion")).toBeInTheDocument()
  })

  it("keeps work the reader watched open once the turn settles", () => {
    const { rerender } = render(<TurnSection turn={turn} index={0} turnKey="turn" isLast={true} />, { wrapper })
    expect(screen.getByRole("button", { name: /working for/i })).toHaveAttribute("aria-expanded", "true")

    mocks.status = "completed"
    rerender(<TurnSection turn={turn} index={0} turnKey="turn" isLast={true} />)

    expect(screen.getByRole("button", { name: /worked for/i })).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("Streaming response")).toBeInTheDocument()
    expect(screen.getByText("Final response")).toBeInTheDocument()
  })

  it("still folds completed work by default", () => {
    mocks.status = "completed"

    render(<TurnSection turn={turn} index={0} turnKey="turn" isLast={true} />, { wrapper })

    expect(screen.getByRole("button", { name: /worked for/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    )
    expect(screen.queryByText("Streaming response")).not.toBeInTheDocument()
    expect(screen.queryByText("AskUserQuestion")).not.toBeInTheDocument()
    expect(screen.getByText("Final response")).toBeInTheDocument()
  })
})

describe("TurnSection navigation", () => {
  beforeEach(() => {
    mocks.status = "completed"
    mocks.activeToolCallId = null
  })

  it("opens the folded work when navigation reveals a call inside it, by turn key", () => {
    let store: TimelineStateStore | null = null
    function Capture() {
      store = useTimelineStore()
      return null
    }
    render(<><Capture /><TurnSection turn={turn} index={0} turnKey="turn" isLast={true} /></>, { wrapper })
    expect(screen.getByRole("button", { name: /worked for/i })).toHaveAttribute("aria-expanded", "false")

    act(() => revealToolCall(store!, "turn", turn, "question-1"))

    expect(screen.getByRole("button", { name: /worked for/i })).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("AskUserQuestion")).toBeInTheDocument()
  })
})

describe("TurnSection agent messages", () => {
  beforeEach(() => {
    mocks.isLive = true
  })

  it("renders a peer message as a card naming its sender", () => {
    mocks.status = "completed"

    render(<TurnSection turn={mailTurn} index={0} turnKey="turn" isLast={true} />, { wrapper })

    expect(screen.getByText("csp-and-proxy")).toBeInTheDocument()
    expect(screen.getByText("One blocking question on finding #1.")).toBeInTheDocument()
  })

  it("keeps an unanswered peer message waiting while its turn is the live one", () => {
    mocks.status = "thinking"

    render(<TurnSection turn={mailTurn} index={0} turnKey="turn" isLast={true} />, { wrapper })

    expect(screen.getByText(/Awaiting your reply/i)).toBeInTheDocument()
  })

  it("keeps waiting on an unanswered peer message from an earlier turn", () => {
    mocks.status = "thinking"

    // The mocked session holds one turn, so index 1 sits behind the live one.
    // The wait is a property of the session, not of the turn the message landed
    // in: a question you lost track of several turns ago is still answerable,
    // and is the single most valuable thing this card surfaces.
    render(<TurnSection turn={mailTurn} index={1} turnKey="turn" isLast={false} />, { wrapper })

    expect(screen.getByText(/Awaiting your reply/i)).toBeInTheDocument()
    expect(screen.queryByText(/Never answered/i)).not.toBeInTheDocument()
  })

  it("settles an unanswered peer message once the session is no longer live", () => {
    mocks.isLive = false
    mocks.status = "completed"

    render(<TurnSection turn={mailTurn} index={0} turnKey="turn" isLast={true} />, { wrapper })

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
    render(<TurnSection turn={promptTurn} index={0} turnKey="turn" isLast={true} />, { wrapper })

    expect(triggerFor("Do the thing")).not.toBeNull()
  })

  it("leaves the rest of the turn to the platform's own context menu", () => {
    render(<TurnSection turn={promptTurn} index={0} turnKey="turn" isLast={true} />, { wrapper })

    expect(triggerFor("Final response")).toBeNull()
  })

  it("skips redo ghosts, which sit past the last restorable turn", () => {
    // The mocked session holds one turn, so index 1 can only be a ghost.
    render(<TurnSection turn={promptTurn} index={1} turnKey="turn" isLast={false} />, { wrapper })

    expect(triggerFor("Do the thing")).toBeNull()
  })
})

describe("TurnSection prompts", () => {
  beforeEach(() => {
    mocks.isLive = false
    mocks.status = "completed"
    mocks.undoEnabled = true
    mocks.optionalContext = null
  })

  const bubblesOf = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>("[data-reader-prompt]")]
  const wakeup = formatTaskWakeup({
    id: "task-1",
    parentSessionId: "session-1",
    childSessionId: "child-1",
    state: "completed",
    result: { turn: { reply: "Pricing copy fixed." } },
  })

  it("sets the reader's own prompt apart as a bubble on the opposite theme, with its time and Restore under it", () => {
    const { container } = render(<TurnSection turn={{ ...turn, userMessage: "Do the thing" }} index={0} turnKey="turn" isLast={true} />, { wrapper })

    const [bubble] = bubblesOf(container)
    expect(bubble).toHaveAttribute("data-reader-prompt", "prompt")
    expect(bubble).toHaveClass("ml-auto", "rounded-2xl", "color-scheme-inverse")
    expect(bubble).toHaveTextContent("Do the thing")
    expect(container.querySelector("time")).toHaveAttribute("datetime", turn.timestamp)
    expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument()
  })

  it("shows a session reporting back as its row, not as the reader's bubble", () => {
    const { container } = render(<TurnSection turn={{ ...turn, userMessage: wakeup }} index={0} turnKey="turn" isLast={true} />, { wrapper })

    expect(bubblesOf(container)).toEqual([])
    const row = container.querySelector("[data-session-row]")
    expect(row).toHaveAttribute("data-session-row", "finished")
    expect(screen.getByRole("button", { name: "Delegated session, Finished: Pricing copy fixed." })).toBeInTheDocument()
    expect(screen.queryByText(/Acknowledge receipt/)).toBeNull()
    // Nobody typed it: Restore stays on the context menu, with no hover row of its own.
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull()
    expect(row?.closest("[data-slot='context-menu-trigger']")).not.toBeNull()
  })

  it("names a reporting session after the start that launched it in this transcript", () => {
    const child = "7d0c1b52-4f0e-4a39-9a51-0f6f2d1c8e11"
    const start: ToolCall = {
      id: "start-1",
      name: "Bash",
      input: { command: `cogpit-session new "Rewrite the pricing copy" --name pricing-copy --agent codex` },
      result: JSON.stringify({ sessionId: child, dirName: "-repo", next: `cogpit-session wait ${child}` }),
      isError: false,
      timestamp: "2026-08-19T11:59:00.000Z",
    }
    mocks.optionalContext = {
      session: { turns: [{ ...turn, id: "turn-start", toolCalls: [start] }] },
      permissions: { send: false },
      actions: {},
    }

    const childWakeup = formatTaskWakeup({ id: "task-1", parentSessionId: "session-1", childSessionId: child, state: "completed", result: { turn: { reply: "Pricing copy fixed." } } })
    render(<TurnSection turn={{ ...turn, userMessage: childWakeup }} index={0} turnKey="turn" isLast={true} />, { wrapper })

    expect(screen.getByRole("button", { name: "pricing-copy, Finished: Pricing copy fixed." })).toBeInTheDocument()
  })

  it("shows a session that cannot go on alone as a row that asks for attention", () => {
    const attention = formatTaskAttention({ id: "task-2", childSessionId: "child-2" }, "It asked: which branch?", [])

    render(<TurnSection turn={{ ...turn, userMessage: attention }} index={0} turnKey="turn" isLast={true} />, { wrapper })

    const row = screen.getByRole("button", { name: "Open Delegated session, Needs attention" })
    expect(row).toHaveTextContent("It asked: which branch?")
  })

  it("runs a system event full width, without a bubble or a hover row", () => {
    const notification = "<task-notification><task-id>t</task-id><status>completed</status><summary>Build finished</summary></task-notification>"

    const { container } = render(<TurnSection turn={{ ...turn, userMessage: notification }} index={0} turnKey="turn" isLast={true} />, { wrapper })

    expect(bubblesOf(container)).toEqual([])
    expect(container.querySelector("[data-task-notification]")).toHaveTextContent("Build finished")
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull()
  })

  it("shows no prompt for one that only carries injected context, keeping the turn's actions", () => {
    const { container } = render(
      <TurnSection turn={{ ...turn, userMessage: "<system-reminder>The date changed.</system-reminder>" }} index={0} turnKey="turn" isLast={true} />,
      { wrapper },
    )

    expect(bubblesOf(container)).toEqual([])
    expect(screen.queryByText(/The date changed/)).toBeNull()
    expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument()
  })

  it("shows a prompt sent mid-turn as the reader's bubble, labelled as queued", () => {
    const queuedTurn: Turn = {
      ...turn,
      id: "turn-queued",
      contentBlocks: [
        { kind: "text", text: ["Working on it"] },
        { kind: "queued_prompt", content: "Also check mobile", timestamp: "2026-08-19T12:00:01.000Z" },
        { kind: "text", text: ["Final response"] },
      ],
      toolCalls: [],
    }

    const { container } = render(<TurnSection turn={queuedTurn} index={0} turnKey="turn" isLast={true} />, { wrapper })

    expect(screen.getByText("Sent while it was working")).toBeInTheDocument()
    const queued = bubblesOf(container).find((bubble) => bubble.dataset.readerPrompt === "1")
    expect(queued).toHaveClass("ml-auto", "color-scheme-inverse")
    expect(queued).toHaveTextContent("Also check mobile")
  })

  it("shows a crew chat post that arrived mid-turn as what happened, not as the reader's bubble", () => {
    const post = formatCrewChatDelivery(
      { sequence: 3, id: "m3", rootId: "root", author: { kind: "agent", name: "ring-deploy" }, text: "One correction on (B)", mentions: [], createdAt: 0 },
      true,
      "cogpit-session chat fetch 'root'",
      "cogpit-session chat post 'root' <text>",
    )
    const crewTurn: Turn = {
      ...turn,
      id: "turn-crew-post",
      contentBlocks: [
        { kind: "text", text: ["Working on it"] },
        { kind: "queued_prompt", content: post, timestamp: "2026-08-19T12:00:01.000Z" },
      ],
      toolCalls: [],
    }

    const { container } = render(<TurnSection turn={crewTurn} index={0} turnKey="turn" isLast={true} />, { wrapper })

    expect(screen.getByRole("article", { name: "Crew chat message from ring-deploy" })).toHaveTextContent("One correction on (B)")
    expect(screen.queryByText("Sent while it was working")).toBeNull()
    expect(bubblesOf(container)).toEqual([])
  })
})

describe("TurnSection sessions it started", () => {
  beforeEach(() => {
    mocks.isLive = false
    mocks.status = "completed"
    mocks.undoEnabled = false
    mocks.optionalContext = null
  })

  const LANE = "01a11695-2938-7ec2-9d9c-0c8af023bd5f"
  const read: ToolCall = {
    id: "read-1",
    name: "Read",
    input: { file_path: "/workspace/routes.ts" },
    result: "export {}",
    isError: false,
    timestamp: "2026-08-19T12:00:01.000Z",
  }
  const start: ToolCall = {
    id: "start-1",
    name: "Bash",
    input: { command: `cogpit-session new "Audit the API routes" --name audit --agent codex` },
    result: JSON.stringify({ sessionId: LANE, dirName: "-repo", next: `cogpit-session wait ${LANE}` }),
    isError: false,
    timestamp: "2026-08-19T12:00:02.000Z",
  }
  const crewTurn = (startCall: ToolCall): Turn => ({
    ...turn,
    id: "turn-crew",
    contentBlocks: [
      { kind: "tool_calls", toolCalls: [read] },
      { kind: "tool_calls", toolCalls: [startCall] },
      { kind: "text", text: ["Started the audit"] },
    ],
    assistantText: ["Started the audit"],
    toolCalls: [read, startCall],
  })

  it("shows a crew start as the session it started, in view while the rest of the work folds", () => {
    render(<TurnSection turn={crewTurn(start)} index={0} turnKey="turn" isLast={true} />, { wrapper })

    const fold = screen.getByRole("button", { name: /worked/i })
    expect(fold).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText("Read")).toBeNull()
    expect(screen.queryByText("Bash")).toBeNull()
    const row = screen.getByRole("button", { name: "audit, Started: Audit the API routes" })

    fireEvent.click(row)
    expect(document.getElementById(row.getAttribute("aria-controls")!)).toHaveTextContent("Codex")
    expect(screen.getByRole("button", { name: "Command" })).toHaveAttribute("aria-expanded", "false")

    fireEvent.click(fold)
    expect(screen.getByText("Read")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "audit, Started: Audit the API routes" })).toBeInTheDocument()
  })

  it("shows a start still running in the live turn as starting", () => {
    mocks.isLive = true
    mocks.status = "thinking"

    render(<TurnSection turn={crewTurn({ ...start, result: null })} index={0} turnKey="turn" isLast={true} />, { wrapper })

    expect(screen.getByRole("button", { name: "audit, Starting: Audit the API routes" })).toBeInTheDocument()
  })

  it("keeps a sub-agent a tool row with its activity panel: only crew sessions get session rows", () => {
    const task: ToolCall = {
      id: "task-1",
      name: "Task",
      input: { description: "Map the routes", prompt: "Find every API route", subagent_type: "Explore" },
      result: "Found 12 routes.\nagentId: agent-1",
      isError: false,
      timestamp: "2026-08-19T12:00:02.000Z",
    }
    const agentMessage = { agentId: "agent-1", parentToolUseId: "task-1", toolCalls: [] } as unknown as SubAgentMessage
    const agentTurn: Turn = {
      ...turn,
      id: "turn-agent",
      contentBlocks: [
        { kind: "tool_calls", toolCalls: [task] },
        { kind: "sub_agent", messages: [agentMessage] },
        { kind: "text", text: ["Mapped"] },
      ],
      assistantText: ["Mapped"],
      toolCalls: [task],
      subAgentActivity: [agentMessage],
    }

    const { container } = render(<TurnSection turn={agentTurn} index={0} turnKey="turn" isLast={true} />, { wrapper })
    fireEvent.click(screen.getByRole("button", { name: /worked/i }))

    expect(container.querySelector("[data-session-row]")).toBeNull()
    // Rendered by the tool-call group (mocked here to list its calls by name).
    expect(screen.getByText("Task")).toBeInTheDocument()
    expect(screen.getByText("Sub-agent activity")).toBeInTheDocument()
  })
})
