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
  useSessionContextOptional: () => null,
  useSessionContext: () => ({
    session: { turns: [], digest: { status: { status: "thinking" } }, cwd: "/tmp" },
    isLive: true,
    isSubAgentView: false,
    undoRedo: { enabled: false },
    actions: {},
  }),
}))

vi.mock("@/hooks/useSkillMetadata", () => ({ useSkillMetadata: () => new Map() }))


vi.mock("../AgentStatusIndicator", () => ({ LiveElapsed: () => <span>elapsed</span> }))

vi.mock("../AgentPanel", () => ({ AgentPanel: () => <div>sub-agent</div> }))

vi.mock("../ThinkingBlock", () => ({ ThinkingBlock: () => <div>thinking</div> }))

vi.mock("../ToolCallCard", () => ({
  ToolCallCard: ({ toolCall }: { toolCall: ToolCall }) => (
    <div data-testid="tool-card">{toolCall.name}</div>
  ),
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

    fireEvent.click(screen.getByRole("button", { name: /Ran 1 command, read 1 file/ }))
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

    fireEvent.click(screen.getByRole("button", { name: /Searched once, wrote 1 file/ }))
    expect(screen.getAllByTestId("tool-card")).toHaveLength(2)

    const after: TurnContentBlock[] = [before[0], before[1], agentBlock("agent-2"), group]
    rerender(<TurnSection turn={makeTurn(after)} index={0} />)

    expect(screen.getAllByTestId("tool-card")).toHaveLength(2)
  })

  it("stays expanded when a thinking-only run gains its first tool call", () => {
    const thinking: TurnContentBlock = { kind: "thinking", blocks: [{ thinking: "hmm" } as never], timestamp: "2026-08-19T12:00:01.000Z" }
    const { rerender } = render(<TurnSection turn={makeTurn([thinking])} index={0} />)

    fireEvent.click(screen.getByRole("button", { name: "Expand Thinking: Thought" }))
    expect(screen.getByText("thinking")).toBeInTheDocument()

    rerender(<TurnSection turn={makeTurn([thinking, { kind: "tool_calls", toolCalls: [call("a", "Bash")] }])} index={0} />)

    expect(screen.getByRole("button", { name: /^Collapse 1 tool call/ })).toHaveAttribute("aria-expanded", "true")
    expect(screen.getAllByTestId("tool-card")).toHaveLength(1)
    expect(screen.getByText("thinking")).toBeInTheDocument()
  })

  it("keeps the work after a session start expanded as calls stream into it", () => {
    const start: ToolCall = {
      ...call("start", "Bash"),
      input: { command: `cogpit-session new "Audit the routes" --name audit` },
      result: '{"sessionId":"01a11695-2938-7ec2-9d9c-0c8af023bd5f"}',
    }
    const thinking: TurnContentBlock = { kind: "thinking", blocks: [{ thinking: "next" } as never], timestamp: "2026-08-19T12:00:02.000Z" }
    const before: TurnContentBlock[] = [{ kind: "tool_calls", toolCalls: [start] }, thinking]
    const { rerender } = render(<TurnSection turn={makeTurn(before)} index={0} />)

    expect(screen.getByRole("button", { name: "audit, Started: Audit the routes" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Expand Thinking: Thought" }))

    rerender(<TurnSection turn={makeTurn([...before, { kind: "tool_calls", toolCalls: [call("b", "Read")] }])} index={0} />)

    expect(screen.getByRole("button", { name: /^Collapse 1 tool call/ })).toHaveAttribute("aria-expanded", "true")
    expect(screen.getAllByTestId("tool-card")).toHaveLength(1)
    expect(screen.getByRole("button", { name: "audit, Started: Audit the routes" })).toBeInTheDocument()
  })
})
