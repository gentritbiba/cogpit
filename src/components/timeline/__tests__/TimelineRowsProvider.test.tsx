import { Profiler } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { TurnSection } from "../TurnSection"
import { TimelineRowsProvider, useTimelineRowFacts, type TimelineRowFacts } from "../TimelineRowsProvider"
import { emptyTurn } from "@/__tests__/fixtures"
import type { ParsedSession, ToolCall, Turn, TurnContentBlock } from "../../../../shared/session/types"

// The real rows, tool groups and tool cards render here. A session update is
// simulated the way App delivers one: a new session object and a new context
// value with fresh `actions` and `undoRedo` objects, while unchanged turns and
// blocks keep their identity.
const mocks = vi.hoisted(() => ({
  session: null as unknown as ParsedSession,
  undoEnabled: false,
  openBranches: (() => {}) as (turnIndex: number) => void,
  statusRenders: new Map<string, number>(),
  skills: new Map(),
}))

vi.mock("@/contexts/AppContext", () => ({
  useAppContext: () => ({
    state: { activeTurnIndex: null, activeToolCallId: null, expandAll: false, expandToolPayloads: false },
    isMobile: false,
  }),
}))

vi.mock("@/contexts/SessionContext", () => ({
  useSessionContextOptional: () => null,
  useSessionContext: () => ({
    session: mocks.session,
    sessionSource: null,
    isLive: true,
    isSubAgentView: false,
    pendingInteraction: null,
    permissions: { send: true, answer: true },
    undoRedo: { enabled: mocks.undoEnabled, branches: [], branchesAtTurn: () => [], requestUndo: () => {} },
    actions: { handleOpenBranches: mocks.openBranches, handleBranchFromHere: () => {} },
  }),
}))

vi.mock("@/hooks/useSkillMetadata", () => ({ useSkillMetadata: () => mocks.skills }))
vi.mock("../../../../shared/session/sessionStatus", () => ({ deriveSessionStatus: () => ({ status: "thinking" }) }))
vi.mock("../AgentStatusIndicator", () => ({ LiveElapsed: () => <span>elapsed</span> }))
vi.mock("@/lib/shiki", () => ({ highlightCode: vi.fn().mockResolvedValue([]), getLangFromPath: vi.fn().mockReturnValue(null) }))

// Rendered by every tool card on every render of the card, so it counts them.
vi.mock("../ToolCallStatus", () => ({
  ToolCallStatus: ({ toolCall }: { toolCall: ToolCall }) => {
    mocks.statusRenders.set(toolCall.id, (mocks.statusRenders.get(toolCall.id) ?? 0) + 1)
    return null
  },
  ToolOperationIcon: () => null,
}))

const TIME = "2026-11-07T10:00:00.000Z"

function call(id: string): ToolCall {
  return { id, name: "Read", input: { file_path: `/repo/${id}.ts` }, result: "ok", isError: false, timestamp: TIME }
}

function turnOf(id: string, contentBlocks: TurnContentBlock[]): Turn {
  return emptyTurn({
    id,
    userMessage: `prompt ${id}`,
    contentBlocks,
    toolCalls: contentBlocks.flatMap((block) => block.kind === "tool_calls" ? block.toolCalls : []),
    timestamp: TIME,
  })
}

function sessionOf(turns: Turn[]): ParsedSession {
  return {
    sessionId: "session-1", version: "1", gitBranch: "", cwd: "/repo", slug: "", name: "", model: "",
    turns,
    stats: { totalInputTokens: 0, totalOutputTokens: 0, totalCacheCreationTokens: 0, totalCacheReadTokens: 0, toolCallCounts: {}, errorCount: 0, totalDurationMs: 0, turnCount: turns.length },
    rawMessages: [],
  }
}

let rowCommits: string[] = []
let facts: TimelineRowFacts | null = null

function FactsProbe() {
  facts = useTimelineRowFacts()
  return null
}

function Timeline({ session }: { session: ParsedSession }) {
  return (
    <TimelineRowsProvider>
      <FactsProbe />
      {session.turns.map((turn, index) => (
        <Profiler key={turn.id} id={turn.id} onRender={(id) => rowCommits.push(id)}>
          <TurnSection turn={turn} index={index} turnKey={turn.id} isLast={index === session.turns.length - 1} />
        </Profiler>
      ))}
    </TimelineRowsProvider>
  )
}

function show(session: ParsedSession, rerender?: (ui: React.ReactElement) => void) {
  mocks.session = session
  if (rerender) rerender(<Timeline session={session} />)
  else return render(<Timeline session={session} />)
}

beforeEach(() => {
  mocks.undoEnabled = false
  mocks.openBranches = () => {}
  mocks.statusRenders.clear()
  rowCommits = []
  facts = null
})

describe("TimelineRowsProvider", () => {
  it("lets a streamed session update with unchanged facts re-render neither a mounted tool card nor a settled row", () => {
    const settled = [turnOf("t0", [{ kind: "tool_calls", toolCalls: [call("c0")] }]), turnOf("t1", [{ kind: "tool_calls", toolCalls: [call("c1")] }])]
    const liveCalls: TurnContentBlock = { kind: "tool_calls", toolCalls: [call("c2")] }
    const { rerender } = show(sessionOf([...settled, turnOf("live", [liveCalls, { kind: "text", text: ["streaming"], timestamp: TIME }])]))!
    rowCommits = []

    for (let record = 0; record < 3; record++) {
      show(sessionOf([...settled, turnOf("live", [liveCalls, { kind: "text", text: [`streaming ${record}`], timestamp: TIME }])]), rerender)
    }

    expect(rowCommits.filter((id) => id !== "live")).toEqual([])
    expect(Object.fromEntries(mocks.statusRenders)).toEqual({ c0: 1, c1: 1, c2: 1 })
  })

  it("changes the facts when a capability flips, so rows show or hide what it allows", () => {
    const { rerender } = show(sessionOf([turnOf("t0", [])]))!
    const before = facts
    expect(before?.restoreToHere).toBeUndefined()
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull()

    mocks.undoEnabled = true
    show(sessionOf([turnOf("t0", [])]), rerender)

    expect(facts).not.toBe(before)
    expect(facts?.restoreToHere).toBeInstanceOf(Function)
    expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument()
  })

  it("keeps an action's identity across updates while calling the latest one", () => {
    const first = vi.fn()
    mocks.openBranches = first
    const { rerender } = show(sessionOf([turnOf("t0", [])]))!
    const wrapper = facts?.openBranches

    const latest = vi.fn()
    mocks.openBranches = latest
    show(sessionOf([turnOf("t0", [])]), rerender)

    expect(facts?.openBranches).toBe(wrapper)
    facts?.openBranches?.(3)
    expect(latest).toHaveBeenCalledWith(3)
    expect(first).not.toHaveBeenCalled()
  })
})
