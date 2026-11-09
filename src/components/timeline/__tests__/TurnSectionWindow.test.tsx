import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen } from "@testing-library/react"
import { TurnSection } from "../TurnSection"
import { TimelineRowsProvider } from "../TimelineRowsProvider"
import { BlockWindowHostContext } from "../WindowedItems"
import { ACTIVE_TURN_KEY, revealKey, useTimelineStore, type TimelineStateStore } from "../disclosure"
import { emptyTurn } from "@/__tests__/fixtures"
import type { BlockWindowHost } from "@/lib/timelineScroll/blockWindow"
import type { ParsedSession, ToolCall, Turn, TurnContentBlock } from "../../../../shared/session/types"

const mocks = vi.hoisted(() => ({
  session: null as unknown as ParsedSession,
  expandAll: false,
  skills: new Map(),
}))

vi.mock("@/contexts/AppContext", () => ({
  useAppContext: () => ({
    state: { activeTurnIndex: null, activeToolCallId: null, expandAll: mocks.expandAll, expandToolPayloads: false },
    isMobile: false,
  }),
}))

vi.mock("@/contexts/SessionContext", () => ({
  useSessionContextOptional: () => null,
  useSessionContext: () => ({
    session: mocks.session,
    sessionSource: null,
    isLive: false,
    isSubAgentView: false,
    pendingInteraction: null,
    permissions: { send: false, answer: false },
    undoRedo: { enabled: false, branches: [], branchesAtTurn: () => [], requestUndo: () => {} },
    actions: { handleOpenBranches: () => {} },
  }),
}))

vi.mock("@/hooks/useSkillMetadata", () => ({ useSkillMetadata: () => mocks.skills }))

vi.mock("../AssistantText", () => ({
  AssistantText: ({ text }: { text: string }) => <p>{text}</p>,
}))

vi.mock("../ToolCallCard", () => ({
  ToolCallCard: ({ toolCall }: { toolCall: ToolCall }) => <div data-tool-call-id={toolCall.id}>call {toolCall.id}</div>,
}))

const TIME = "2026-11-07T10:00:00.000Z"

function sessionOf(turn: Turn): ParsedSession {
  return {
    sessionId: "session-1", version: "1", gitBranch: "", cwd: "/repo", slug: "", name: "", model: "",
    turns: [turn],
    stats: { totalInputTokens: 0, totalOutputTokens: 0, totalCacheCreationTokens: 0, totalCacheReadTokens: 0, toolCallCounts: {}, errorCount: 0, totalDurationMs: 0, turnCount: 1 },
    rawMessages: [],
  }
}

/** Replies only, so nothing folds: every block is its own window item. */
function giantTurn(blocks: number): Turn {
  const contentBlocks: TurnContentBlock[] = Array.from({ length: blocks }, (_, i) => ({
    kind: "text",
    text: [`reply ${i}`],
    timestamp: new Date(Date.parse(TIME) + i * 1000).toISOString(),
  }))
  return emptyTurn({ id: "giant", userMessage: "go", contentBlocks, timestamp: TIME })
}

function makeHost(offset: number): BlockWindowHost {
  return {
    attachWindow: () => () => {},
    windowCommitted: () => {},
    viewOffsetInRow: () => offset,
    viewportHeight: () => 500,
    layoutKey: () => "40|0",
    blockHeight: () => undefined,
    setBlockHeight: () => {},
  }
}

let store: TimelineStateStore | null = null
function CaptureStore() {
  store = useTimelineStore()
  return null
}

function show(turn: Turn, host: BlockWindowHost | null) {
  mocks.session = sessionOf(turn)
  return render(
    <TimelineRowsProvider>
      <CaptureStore />
      <BlockWindowHostContext.Provider value={host}>
        <TurnSection turn={turn} index={0} turnKey={turn.id} isLast />
      </BlockWindowHostContext.Provider>
    </TimelineRowsProvider>,
  )
}

beforeEach(() => {
  mocks.expandAll = false
  store = null
})

describe("a giant turn in the timeline", () => {
  it("mounts its tail first while the timeline follows the bottom", () => {
    show(giantTurn(200), makeHost(Infinity))
    expect(screen.getByText("reply 199")).toBeInTheDocument()
    expect(screen.queryByText("reply 0")).toBeNull()
    expect(document.querySelectorAll("[data-block-key]").length).toBeLessThan(60)
    expect(document.querySelector("[data-window-spacer]")).not.toBeNull()
  })

  it("marks each item with the content blocks it renders, for find", () => {
    show(giantTurn(200), makeHost(Infinity))
    const last = screen.getByText("reply 199").closest<HTMLElement>("[data-blocks]")!
    expect(last.dataset.blocks).toBe("199-199")
  })

  it("keeps the block a navigation targets mounted", () => {
    show(giantTurn(200), makeHost(Infinity))
    act(() => store!.set(revealKey("giant"), 3))
    expect(screen.getByText("reply 3")).toBeInTheDocument()
    expect(screen.queryByText("reply 2")).toBeNull()
  })

  // LOAD QA F7 (crew 2275): the ring followed the selected index, so a prepend moved it to another turn.
  it("rings the turn whose key the timeline marks as selected, whatever its index", () => {
    const turn = giantTurn(3)
    show(turn, makeHost(Infinity))
    const ringed = () => document.querySelector(".ring-1") !== null
    expect(ringed()).toBe(false)
    act(() => store!.set(ACTIVE_TURN_KEY, "giant"))
    expect(ringed()).toBe(true)
    act(() => store!.set(ACTIVE_TURN_KEY, "another"))
    expect(ringed()).toBe(false)
  })

  it("renders every block outside the timeline list", () => {
    show(giantTurn(200), null)
    expect(screen.getByText("reply 0")).toBeInTheDocument()
    expect(screen.getByText("reply 199")).toBeInTheDocument()
  })

  it("windows the calls of a long open group and keeps a revealed call mounted", () => {
    mocks.expandAll = true
    const calls: ToolCall[] = Array.from({ length: 200 }, (_, i) => ({
      id: `c${i}`, name: "Read", input: { file_path: `/repo/${i}.ts` }, result: "ok", isError: false, timestamp: TIME,
    }))
    const turn = emptyTurn({
      id: "giant",
      userMessage: "go",
      contentBlocks: [{ kind: "tool_calls", toolCalls: calls }, { kind: "text", text: ["done"], timestamp: TIME }],
      toolCalls: calls,
      timestamp: TIME,
    })
    show(turn, makeHost(-Infinity))
    expect(document.querySelector('[data-tool-call-id="c0"]')).not.toBeNull()
    expect(document.querySelector('[data-tool-call-id="c199"]')).toBeNull()

    act(() => store!.set(revealKey("giant"), "c150"))
    expect(document.querySelector('[data-tool-call-id="c150"]')).not.toBeNull()
  })
})
