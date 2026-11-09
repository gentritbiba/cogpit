import { beforeEach, describe, expect, it, vi } from "vitest"
import { EMPTY_SESSION_DIGEST } from "../../../../shared/session/sessionDigest"
import { fireEvent, render, screen } from "@testing-library/react"
import { StreamingOverlayProvider } from "@/contexts/StreamingOverlayContext"
import type { StreamingOverlay } from "@/lib/streamingOverlay"
import { emptyTurn } from "@/__tests__/fixtures"
import { TurnSection } from "../TurnSection"
import { TimelineRowsProvider } from "../TimelineRowsProvider"
import type { SubAgentMessage, ToolCall, Turn, TurnContentBlock } from "../../../../shared/session/types"

// The real tool group, tool card, activity panel and live pane render here;
// only the app and session plumbing around a turn is stubbed.
const mocks = vi.hoisted(() => ({ turns: [] as Turn[] }))

vi.mock("@/contexts/AppContext", () => ({
  useAppContext: () => ({
    state: { expandAll: false, expandToolPayloads: false },
    isMobile: false,
  }),
}))

vi.mock("@/contexts/SessionContext", () => ({
  useSessionContextOptional: () => null,
  useSessionContext: () => ({
    activeTurnIndex: null,
    activeToolCallId: null,
    session: { sessionId: "session-1", turns: mocks.turns, digest: { ...EMPTY_SESSION_DIGEST, status: { status: "thinking" } }, cwd: "/workspace" },
    sessionSource: null,
    isLive: true,
    isSubAgentView: false,
    pendingInteraction: null,
    permissions: { send: false, answer: false },
    undoRedo: { enabled: false, branches: [] },
    actions: {},
  }),
}))

vi.mock("@/hooks/useSkillMetadata", () => ({ useSkillMetadata: () => new Map() }))
vi.mock("../AgentStatusIndicator", () => ({ LiveElapsed: () => <span>elapsed</span> }))

const TIME = "2026-11-05T10:00:00.000Z"

const overlay: StreamingOverlay = [{
  messageId: "msg_sub",
  parentToolUseId: "task-1",
  stopped: false,
  blocks: [{ index: 0, blockType: "text", text: "Reading the router" }],
}]

function agentCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return { id: "task-1", name: "Task", input: { description: "Map the routes" }, result: null, isError: false, timestamp: TIME, ...overrides }
}

function agent(overrides: Partial<SubAgentMessage> = {}): SubAgentMessage {
  return {
    agentId: "agent-1", parentToolUseId: "task-1", agentName: null, subagentType: "Explore", type: "assistant",
    content: null, toolCalls: [], thinking: [], text: [], timestamp: TIME, tokenUsage: null, model: null,
    isBackground: false, status: "running", ...overrides,
  }
}

function renderTurn(call: ToolCall, block: TurnContentBlock) {
  const turn = emptyTurn({
    contentBlocks: [{ kind: "tool_calls", toolCalls: [call] }, block],
    toolCalls: [call],
    subAgentActivity: block.kind === "sub_agent" || block.kind === "background_agent" ? block.messages : [],
    timestamp: TIME,
  })
  mocks.turns = [turn]
  return render(
    <StreamingOverlayProvider value={overlay}>
      <TimelineRowsProvider>
        <TurnSection turn={turn} index={0} turnKey="turn" isLast />
      </TimelineRowsProvider>
    </StreamingOverlayProvider>,
  )
}

beforeEach(() => {
  mocks.turns = []
})

describe("a sub-agent's live output", () => {
  it("streams once, under its pending call, while the activity panel shows the agent", () => {
    renderTurn(agentCall(), { kind: "sub_agent", messages: [agent()] })

    const panes = screen.getAllByTestId("live-subagent-transcript")
    expect(panes).toHaveLength(1)
    expect(panes[0]).toHaveTextContent("Reading the router")
    expect(panes[0].closest("[data-tool-call-id]")).toHaveAttribute("data-tool-call-id", "task-1")

    fireEvent.click(screen.getByRole("button", { name: /Sub-agent activity/ }))
    expect(screen.getByText("Working — no return yet")).toBeInTheDocument()
    expect(screen.getAllByTestId("live-subagent-transcript")).toHaveLength(1)
  })

  it("streams from the activity panel once the call has returned and the agent works on in the background", () => {
    const launched = agentCall({ input: { description: "Map the routes", run_in_background: true }, result: "Async agent launched successfully." })
    renderTurn(launched, { kind: "background_agent", messages: [agent({ isBackground: true, status: "async_launched" })] })

    const panes = screen.getAllByTestId("live-subagent-transcript")
    expect(panes).toHaveLength(1)
    expect(panes[0].closest("[data-tool-call-id]")).toBeNull()
  })
})
