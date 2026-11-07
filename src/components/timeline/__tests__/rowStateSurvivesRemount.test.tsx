import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { DisclosureScope } from "../disclosure"
import { TimelineRowsProvider } from "../TimelineRowsProvider"
import { ToolCallCard } from "../ToolCallCard"
import { UserMessage } from "../UserMessage"
import { EditDiffView } from "../EditDiffView"
import { TurnSection } from "../TurnSection"
import { emptyTurn } from "@/__tests__/fixtures"
import { formatCrewChatDelivery, type CrewChatMessage } from "../../../../shared/contracts/crewChat"
import type { ToolCall, TurnContentBlock } from "../../../../shared/session/types"

// Virtualization unmounts a row that leaves the viewport and mounts it again
// when it comes back (plans/SCROLL.md root cause 3). Everything the reader did
// to the row must still be there, and nothing fetched may be fetched again.
const mocks = vi.hoisted(() => ({
  status: "thinking" as "thinking" | "completed",
  pendingQuestion: null as string | null,
  fetch: vi.fn(),
  skills: new Map(),
  branches: [],
}))

vi.mock("@/lib/auth", () => ({ authFetch: mocks.fetch, jsonFetch: mocks.fetch, authUrl: (url: string) => url, isRemoteClient: () => false }))
vi.mock("@/lib/shiki", () => ({ highlightCode: vi.fn().mockResolvedValue([]), getLangFromPath: () => null }))
vi.mock("@/contexts/AppContext", () => ({
  useAppContext: () => ({
    state: { activeTurnIndex: null, activeToolCallId: null, expandAll: false, expandToolPayloads: false },
    isMobile: false,
  }),
}))
vi.mock("@/contexts/SessionContext", () => ({
  useSessionContextOptional: () => null,
  useSessionChatContext: () => ({ chat: { sendMessage: vi.fn() } }),
  useSessionContext: () => ({
    session: { sessionId: "session-1", cwd: "/repo", turns: [], rawMessages: [] },
    sessionSource: null,
    isLive: true,
    isSubAgentView: false,
    pendingInteraction: mocks.pendingQuestion ? { type: "question", toolUseId: mocks.pendingQuestion } : null,
    permissions: { send: true, answer: true },
    undoRedo: { enabled: false, branches: mocks.branches },
    actions: {},
  }),
}))
vi.mock("@/hooks/useSkillMetadata", () => ({ useSkillMetadata: () => mocks.skills }))
vi.mock("../../../../shared/session/sessionStatus", () => ({ deriveSessionStatus: () => ({ status: mocks.status }) }))
vi.mock("../AgentStatusIndicator", () => ({ LiveElapsed: () => <span>elapsed</span> }))

const TIME = "2026-11-07T10:00:00.000Z"

/** One row of the timeline: shown, unmounted as it leaves the viewport, then shown again. */
function useRow(content: () => React.ReactNode) {
  const ui = (shown: boolean) => (
    <TimelineRowsProvider>
      {shown && <DisclosureScope id="turn-1" root>{content()}</DisclosureScope>}
    </TimelineRowsProvider>
  )
  const view = render(ui(true))
  return {
    remount: () => {
      view.rerender(ui(false))
      view.rerender(ui(true))
    },
  }
}

beforeEach(() => {
  mocks.status = "thinking"
  mocks.pendingQuestion = null
  mocks.fetch.mockReset()
})

describe("row state survives a remount", () => {
  it("keeps a turn mounted mid-work open after it settles off screen and comes back", () => {
    const read: ToolCall = { id: "read-1", name: "Read", input: { file_path: "/repo/a.ts" }, result: "ok", isError: false, timestamp: TIME }
    const turn = emptyTurn({
      id: "turn-1",
      contentBlocks: [{ kind: "tool_calls", toolCalls: [read] }, { kind: "text", text: ["Done"], timestamp: TIME }] as TurnContentBlock[],
      toolCalls: [read],
      timestamp: TIME,
    })
    const ui = (shown: boolean) => (
      <TimelineRowsProvider>{shown && <TurnSection turn={turn} index={0} turnKey="turn-1" isLast />}</TimelineRowsProvider>
    )
    const view = render(ui(true))
    expect(screen.getByRole("button", { name: /working for/i })).toHaveAttribute("aria-expanded", "true")

    view.rerender(ui(false))
    mocks.status = "completed"
    view.rerender(ui(true))

    expect(screen.getByRole("button", { name: /worked through 1 step/i })).toHaveAttribute("aria-expanded", "true")
  })

  it("keeps a tool card's open panel", () => {
    const call: ToolCall = { id: "grep-1", name: "Grep", input: { pattern: "needle" }, result: "a.ts:1", isError: false, timestamp: TIME }
    const row = useRow(() => <ToolCallCard toolCall={call} />)
    fireEvent.click(screen.getByRole("button", { name: /Toggle .* details/ }))

    row.remount()

    expect(screen.getByRole("button", { name: /Toggle .* details/ })).toHaveAttribute("aria-expanded", "true")
  })

  it("keeps a half-typed answer to an open question", () => {
    mocks.pendingQuestion = "ask-1"
    const call: ToolCall = {
      id: "ask-1", name: "AskUserQuestion", result: null, isError: false, timestamp: TIME,
      input: { questions: [{ question: "Which database?", header: "DB" }] },
    }
    const row = useRow(() => <ToolCallCard toolCall={call} isAgentActive />)
    fireEvent.change(screen.getByPlaceholderText("Type your answer..."), { target: { value: "Postgres, because" } })

    row.remount()

    expect(screen.getByPlaceholderText("Type your answer...")).toHaveValue("Postgres, because")
  })

  it("shows fetched slash-command content again without fetching it again", async () => {
    const onExpandCommand = vi.fn().mockResolvedValue("Expanded command docs")
    const command = "<command-name>/review</command-name><command-message>review</command-message>"
    const row = useRow(() => <UserMessage content={command} timestamp="" onExpandCommand={onExpandCommand} />)
    fireEvent.click(screen.getByRole("button", { name: "Expand" }))
    await waitFor(() => expect(screen.getByText("Expanded command docs")).toBeInTheDocument())

    row.remount()

    expect(screen.getByText("Expanded command docs")).toBeInTheDocument()
    expect(onExpandCommand).toHaveBeenCalledTimes(1)
  })

  it("shows a fetched crew chat message again without fetching it again", async () => {
    const message: CrewChatMessage = {
      sequence: 7, id: "m-7", rootId: "root-a", mentions: [], createdAt: 0,
      author: { kind: "agent", sessionId: "s-ds", name: "studio-ds" }, text: "tests PASS",
    }
    mocks.fetch.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => ({ rootId: "root-a", canPost: true, nextCursor: 7, hasMore: false, members: [], messages: url.includes("after=") ? [message] : [] }),
    }))
    const delivery = formatCrewChatDelivery(message, false, "cogpit-session chat fetch 'root-a' --after 6", "cogpit-session chat post")
    const row = useRow(() => <UserMessage content={delivery} timestamp="" compact />)
    fireEvent.click(screen.getByRole("button", { name: "Show message" }))
    await waitFor(() => expect(screen.getByRole("article")).toHaveTextContent("tests PASS"))
    const messageFetches = () => mocks.fetch.mock.calls.filter(([url]) => String(url).includes("after=")).length
    expect(messageFetches()).toBe(1)

    row.remount()

    expect(screen.getByRole("article")).toHaveTextContent("tests PASS")
    expect(messageFetches()).toBe(1)
  })

  it("keeps the unchanged lines a reader expanded in a diff", () => {
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index}`)
    const before = lines.join("\n")
    const after = [...lines.slice(0, 29), "changed"].join("\n")
    const row = useRow(() => <EditDiffView oldString={before} newString={after} filePath="/repo/a.ts" />)
    act(() => fireEvent.click(screen.getByRole("button", { name: /unchanged lines/ })))
    expect(screen.getByText("line 3")).toBeInTheDocument()

    row.remount()

    expect(screen.getByText("line 3")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /unchanged lines/ })).toBeNull()
  })
})

describe("late content holds its box", () => {
  it("draws a small diff on its first frame, with no preparing step to resize from", () => {
    render(<EditDiffView oldString={"a\nb"} newString={"a\nc"} filePath="/repo/a.ts" />)

    expect(screen.queryByText("Preparing diff…")).toBeNull()
    expect(screen.getByText("c")).toBeInTheDocument()
  })
})
