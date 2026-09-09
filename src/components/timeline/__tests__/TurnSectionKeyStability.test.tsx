import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { TurnSection } from "../TurnSection"
import type { ToolCall, TurnContentBlock } from "../../../../shared/session/types"
import { emptyTurn } from "@/__tests__/fixtures"

vi.mock("@/contexts/AppContext", () => ({
  useAppContext: () => ({
    state: { activeTurnIndex: null, activeToolCallId: null, expandAll: false, expandToolPayloads: false },
    isMobile: false,
  }),
}))

vi.mock("@/contexts/SessionContext", () => ({
  useSessionContext: () => ({
    session: { turns: [], rawMessages: [], cwd: "/tmp" },
    isLive: true,
    isSubAgentView: false,
    undoRedo: { enabled: false },
    actions: {},
  }),
}))

vi.mock("@/hooks/useNearViewport", () => ({
  useNearViewport: () => ({ ref: { current: null }, isNear: true }),
}))

vi.mock("@/hooks/useSkillMetadata", () => ({ useSkillMetadata: () => new Map() }))

vi.mock("../../../../shared/session/sessionStatus", () => ({ deriveSessionStatus: () => ({ status: "thinking" }) }))

vi.mock("../AgentStatusIndicator", () => ({ LiveElapsed: () => <span>elapsed</span> }))

vi.mock("../AgentPanel", () => ({ AgentPanel: () => <div>sub-agent</div> }))

vi.mock("../ThinkingBlock", () => ({ ThinkingBlock: () => <div>thinking</div> }))

vi.mock("../ToolCallCard", () => ({
  ToolCallCard: ({ toolCall }: { toolCall: ToolCall }) => (
    <div data-testid="tool-card">{toolCall.name}</div>
  ),
  getToolTextStyle: () => "",
}))

function call(id: string, name: string): ToolCall {
  return { id, name, input: {}, result: "ok", isError: false, timestamp: "2026-08-19T12:00:00.000Z" }
}

const makeTurn = (contentBlocks: TurnContentBlock[]) =>
  emptyTurn({
    contentBlocks,
    toolCalls: contentBlocks.flatMap((b) => (b.kind === "tool_calls" ? b.toolCalls : [])),
    timestamp: "2026-08-19T12:00:00.000Z",
  })

const agentBlock = (id: string): TurnContentBlock => ({
  kind: "sub_agent",
  messages: [{ agentId: id } as never],
})

describe("expanded work groups survive live updates", () => {
  it("stays expanded when a block is appended to the group", () => {
    const before = [{ kind: "tool_calls", toolCalls: [call("a", "Bash"), call("b", "Read")] } as TurnContentBlock]
    const { rerender } = render(<TurnSection turn={makeTurn(before)} index={0} />)

    fireEvent.click(screen.getByRole("button", { name: /Run command/ }))
    expect(screen.getAllByTestId("tool-card")).toHaveLength(2)

    const after: TurnContentBlock[] = [
      ...before,
      { kind: "thinking", blocks: [{ text: "hmm" } as never] },
    ]
    rerender(<TurnSection turn={makeTurn(after)} index={0} />)

    expect(screen.getAllByTestId("tool-card")).toHaveLength(2)
  })

  it("stays expanded when an earlier sub-agent block shifts later blocks", () => {
    const group = { kind: "tool_calls", toolCalls: [call("c", "Grep"), call("d", "Write")] } as TurnContentBlock
    const before: TurnContentBlock[] = [
      { kind: "tool_calls", toolCalls: [call("a", "Bash"), call("b", "Read")] },
      agentBlock("agent-1"),
      group,
    ]
    const { rerender } = render(<TurnSection turn={makeTurn(before)} index={0} />)

    fireEvent.click(screen.getByRole("button", { name: /Search files/ }))
    expect(screen.getAllByTestId("tool-card")).toHaveLength(2)

    const after: TurnContentBlock[] = [before[0], before[1], agentBlock("agent-2"), group]
    rerender(<TurnSection turn={makeTurn(after)} index={0} />)

    expect(screen.getAllByTestId("tool-card")).toHaveLength(2)
  })
})
