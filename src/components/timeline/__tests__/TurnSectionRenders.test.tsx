import { beforeEach, describe, expect, it, vi } from "vitest"
import { render } from "@testing-library/react"
import { TurnSection } from "../TurnSection"
import { TimelineRowsProvider } from "../TimelineRowsProvider"
import { emptyTurn } from "@/__tests__/fixtures"
import type { ParsedSession, ToolCall, Turn, TurnContentBlock } from "../../../../shared/session/types"

// Counts renders of the leaf components a block turns into. Rows here keep
// object identity for blocks that did not change, as the live pipeline does.
const mocks = vi.hoisted(() => ({
  session: null as unknown as ParsedSession,
  renders: new Map<string, number>(),
  skills: new Map(),
}))

const count = (key: string) => mocks.renders.set(key, (mocks.renders.get(key) ?? 0) + 1)

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
    permissions: { send: false, answer: false },
    // A fresh object per session update, as App builds it.
    undoRedo: { enabled: false, branches: [], branchesAtTurn: () => [], requestUndo: () => {} },
    actions: { handleOpenBranches: () => {} },
  }),
}))

vi.mock("@/hooks/useSkillMetadata", () => ({ useSkillMetadata: () => mocks.skills }))
vi.mock("../../../../shared/session/sessionStatus", () => ({ deriveSessionStatus: () => ({ status: "thinking" }) }))
vi.mock("../AgentStatusIndicator", () => ({ LiveElapsed: () => <span>elapsed</span> }))

vi.mock("../AssistantText", async () => {
  const { memo } = await import("react")
  return {
    AssistantText: memo(function AssistantText({ text }: { text: string }) {
      count(`text:${text}`)
      return <p>{text}</p>
    }),
  }
})

vi.mock("../CollapsibleToolCalls", async () => {
  const { memo } = await import("react")
  return {
    CollapsibleToolCalls: memo(function CollapsibleToolCalls({ toolCalls }: { toolCalls: ToolCall[] }) {
      count(`calls:${toolCalls.map((call) => call.id).join(",")}`)
      return <div>{toolCalls.length} calls</div>
    }),
  }
})

const TIME = "2026-11-07T10:00:00.000Z"

function call(id: string): ToolCall {
  return { id, name: "Read", input: { file_path: `/repo/${id}.ts` }, result: "ok", isError: false, timestamp: TIME }
}

function text(words: string, second: number): TurnContentBlock {
  return { kind: "text", text: [words], timestamp: `2026-11-07T10:00:${String(second).padStart(2, "0")}.000Z` }
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

/** Renders the rows the way the timeline list does: one memoized row per turn. */
function Timeline({ session }: { session: ParsedSession }) {
  return (
    <TimelineRowsProvider>
      {session.turns.map((turn, index) => (
        <TurnSection key={turn.id} turn={turn} index={index} turnKey={turn.id} isLast={index === session.turns.length - 1} />
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
  mocks.renders.clear()
})

describe("rendering per streamed record", () => {
  it("re-renders only the block that changed in a running turn", () => {
    const answer = text("first answer", 1)
    const group = { kind: "tool_calls", toolCalls: [call("a"), call("b")] } as TurnContentBlock
    const before = turnOf("live", [answer, group, text("streaming", 3)])
    const { rerender } = show(sessionOf([before]))!

    // The next record grows the last text block; everything before it keeps its identity.
    const after = turnOf("live", [answer, group, text("streaming more", 3)])
    show(sessionOf([after]), rerender)

    expect(mocks.renders.get("text:first answer")).toBe(1)
    expect(mocks.renders.get("text:streaming more")).toBe(1)
  })

  it("re-renders only the activity run a new call joined", () => {
    const answer = text("first answer", 1)
    const settled = { kind: "tool_calls", toolCalls: [call("a")] } as TurnContentBlock
    const before = turnOf("live", [settled, answer, { kind: "tool_calls", toolCalls: [call("b")] }])
    const { rerender } = show(sessionOf([before]))!

    const after = turnOf("live", [settled, answer, { kind: "tool_calls", toolCalls: [call("b"), call("c")] }])
    show(sessionOf([after]), rerender)

    expect(mocks.renders.get("calls:a")).toBe(1)
    expect(mocks.renders.get("text:first answer")).toBe(1)
    expect(mocks.renders.get("calls:b,c")).toBe(1)
  })

  it("leaves settled rows alone while the live turn streams", () => {
    const earlier = Array.from({ length: 20 }, (_, index) => turnOf(`t${index}`, [
      { kind: "tool_calls", toolCalls: [call(`t${index}-call`)] },
      text(`answer ${index}`, 1),
    ]))
    const { rerender } = show(sessionOf([...earlier, turnOf("live", [text("streaming", 2)])]))!
    mocks.renders.clear()

    for (let record = 0; record < 5; record++) {
      show(sessionOf([...earlier, turnOf("live", [text(`streaming ${record}`, 2)])]), rerender)
    }

    const settledRenders = [...mocks.renders].filter(([key]) => !key.startsWith("text:streaming"))
    expect(settledRenders).toEqual([])
  })
})
