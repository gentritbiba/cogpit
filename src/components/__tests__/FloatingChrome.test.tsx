import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { FloatingChrome } from "@/components/FloatingChrome"
import { setMe, __resetCapabilitiesForTest } from "@/lib/capabilities"
import { getResumeCommand } from "@/lib/sessionSource"
import type { AgentKind } from "@/lib/sessionSource"
import { MEMBER_CAPABILITIES } from "../../../shared/contracts/team"
import type { ActiveSessionInfo } from "@/components/LiveSessions/types"
import type { ParsedSession, Turn } from "@/lib/types"

const mocks = vi.hoisted(() => ({
  config: {
    networkUrl: null as string | null,
    defaultAgentKind: "claude" as const,
    networkAccessDisabled: false,
  },
  session: null as ParsedSession | null,
  sessionSource: null as {
    dirName: string
    fileName: string
    rawText: string
    agentKind?: AgentKind
  } | null,
  isLive: false,
  copy: vi.fn(),
  copyToClipboard: vi.fn(),
  dispatch: vi.fn(),
  authFetch: vi.fn(),
  toastSuccess: vi.fn(),
  inventorySessions: [] as ActiveSessionInfo[],
}))

vi.mock("@/contexts/AppContext", () => ({
  useAppContext: () => ({ config: mocks.config, dispatch: mocks.dispatch }),
}))
vi.mock("@/contexts/SessionContext", () => ({
  useSessionContext: () => ({
    session: mocks.session,
    sessionSource: mocks.sessionSource,
    isLive: mocks.isLive,
  }),
}))
vi.mock("@/contexts/SessionInventoryContext", () => ({
  useSessionInventoryOptional: () => ({ sessions: mocks.inventorySessions }),
}))
vi.mock("@/hooks/useCopyWithFeedback", () => ({
  useCopyWithFeedback: () => [false, mocks.copy],
}))
vi.mock("@/hooks/useCapability", () => ({ useCapability: () => true }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))
vi.mock("@/lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/utils")>()),
  copyToClipboard: mocks.copyToClipboard,
}))
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess } }))
vi.mock("@/components/TokenUsageWidget", () => ({ TokenUsageIndicator: () => null }))
vi.mock("@/components/LeakIndicator", () => ({ LeakIndicator: () => null }))
vi.mock("@/components/DeviceSwitcher", () => ({ DeviceSwitcher: () => null }))
vi.mock("@/components/NotificationsBell", () => ({ NotificationsBell: () => null }))
vi.mock("@/components/PowerMonitor", () => ({
  PowerMonitor: ({ open }: { open: boolean }) => (open ? <div data-testid="power-monitor" /> : null),
}))
vi.mock("@/components/UsageCostDialog", () => ({
  UsageCostDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="usage-dialog" /> : null),
}))

const PROPS = {
  showSidebar: true,
  sidebarShortcut: "\u2318B",
  showStats: false,
  killing: false,
  creatingSession: false,
  onNewSession: vi.fn(),
  onDuplicateSession: vi.fn(),
  onOpenTerminal: vi.fn(),
  onBackToMain: vi.fn(),
  onShowWorkflows: vi.fn(),
  workflowCount: 0,
  onToggleSidebar: vi.fn(),
  onToggleStats: vi.fn(),
  onKillAll: vi.fn(),
  onOpenSettings: vi.fn(),
}

function prTurn(id: string, command: string, result: string): Turn {
  return {
    id,
    userMessage: null,
    contentBlocks: [],
    thinking: [],
    assistantText: [],
    toolCalls: [{
      id: `tool-${id}`,
      name: "Bash",
      input: { command },
      result,
      isError: false,
      timestamp: "2026-08-14T10:00:00.000Z",
    }],
    subAgentActivity: [],
    timestamp: "2026-08-14T10:00:00.000Z",
    durationMs: null,
    tokenUsage: null,
    model: null,
  }
}

function makeSession(overrides: Partial<ParsedSession> = {}): ParsedSession {
  return {
    sessionId: "test-session-id",
    version: "1.0",
    gitBranch: "",
    cwd: "/tmp/project",
    slug: "my-session",
    name: "",
    model: "",
    turns: [],
    stats: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      toolCallCounts: {},
      errorCount: 0,
      totalDurationMs: 0,
      turnCount: 0,
    },
    rawMessages: [],
    agentKind: "claude",
    ...overrides,
  }
}

function withScannedSession(sessionId: string, pullRequests: ActiveSessionInfo["pullRequests"]): void {
  mocks.inventorySessions = [{
    dirName: "d",
    projectShortName: "P",
    fileName: "f.jsonl",
    sessionId,
    lastModified: "2026-08-14T10:00:00.000Z",
    size: 1,
    pullRequests,
  }]
}

function renderChrome(overrides: Partial<typeof PROPS> = {}): ReturnType<typeof render> {
  return render(<FloatingChrome {...PROPS} {...overrides} />)
}

function sessionPill(): HTMLElement {
  return screen.getByRole("button", { name: /my-session/ })
}

async function openSessionDetails(
  user: ReturnType<typeof userEvent.setup>,
): Promise<HTMLElement> {
  await user.hover(sessionPill())
  return screen.findByRole("tooltip")
}

describe("FloatingChrome", () => {
  beforeEach(() => {
    mocks.config = { networkUrl: null, defaultAgentKind: "claude", networkAccessDisabled: false }
    mocks.session = makeSession()
    mocks.sessionSource = {
      dirName: "-tmp-project",
      fileName: "test-session-id.jsonl",
      rawText: "",
      agentKind: "claude",
    }
    mocks.isLive = false
    mocks.inventorySessions = []
    mocks.authFetch.mockResolvedValue({ ok: true, status: 200, json: async () => [] })
    window.history.replaceState({}, "", "/")
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    __resetCapabilitiesForTest()
  })

  it("owns the window-drag strip and paints it under the pills", () => {
    const { container } = renderChrome()

    // The strip has to be a sibling of the pill row, and lower: anywhere else
    // (a resizable panel, say) it lands in its own stacking context and covers
    // the pills instead of sitting behind them.
    const strip = container.querySelector(".drag-strip")
    const pillRow = sessionPill().closest(".pointer-events-auto")?.parentElement
    expect(strip).toBeInTheDocument()
    expect(strip).toHaveClass("z-10")
    expect(pillRow).toHaveClass("z-30")
    expect(strip?.parentElement).toBe(pillRow?.parentElement)
    expect(strip?.compareDocumentPosition(pillRow as Node))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it("copies the resume command from the project/session breadcrumb", () => {
    renderChrome()

    fireEvent.click(screen.getByRole("button", { name: /my-session/ }))

    expect(mocks.copy).toHaveBeenCalledWith(
      getResumeCommand("claude", "test-session-id", "/tmp/project"),
    )
    expect(screen.getByText("project")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Copy resume command" })).not.toBeInTheDocument()
  })

  it("opens all six session operations from the breadcrumb context menu", async () => {
    renderChrome()

    fireEvent.contextMenu(screen.getByRole("button", { name: /my-session/ }))

    expect(await screen.findByRole("menuitem", { name: "New session in this project" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Duplicate this session" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Open project in editor" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Reveal in file manager" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Open terminal in project" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "View all sessions in this project" })).toBeInTheDocument()
  })

  it("preserves project action request and project-session navigation semantics", async () => {
    renderChrome()
    const breadcrumb = screen.getByRole("button", { name: /my-session/ })

    fireEvent.contextMenu(breadcrumb)
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open project in editor" }))

    expect(mocks.authFetch).toHaveBeenCalledWith("/api/open-in-editor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/project", dirName: "-tmp-project" }),
    })

    fireEvent.contextMenu(breadcrumb)
    fireEvent.click(await screen.findByRole("menuitem", { name: "View all sessions in this project" }))

    expect(mocks.dispatch).toHaveBeenNthCalledWith(1, { type: "GO_HOME", isMobile: false })
    expect(mocks.dispatch).toHaveBeenNthCalledWith(2, {
      type: "SET_DASHBOARD_PROJECT",
      dirName: "-tmp-project",
    })
  })

  it("shows the session state that used to occupy the two lower bars", async () => {
    const user = userEvent.setup()
    const thinkingTurn = prTurn("thinking", "echo ok", "ok")
    thinkingTurn.thinking = [{ type: "thinking", thinking: "Working", signature: "sig" }]
    mocks.session = makeSession({
      model: "claude-opus-4-5",
      gitBranch: "feat/clean-header",
      turns: [thinkingTurn],
      branchedFrom: { sessionId: "parent-session", turnIndex: 2 },
      rawMessages: [{
        type: "assistant",
        message: {
          model: "claude-opus-4-5",
          usage: {
            input_tokens: 50_000,
            output_tokens: 1_000,
            cache_creation_input_tokens: 10_000,
            cache_read_input_tokens: 5_000,
          },
        },
      }],
    })
    mocks.isLive = true

    renderChrome({ workflowCount: 2 })

    expect(screen.getByText("opus")).toBeInTheDocument()
    expect(screen.getByLabelText("Session is live")).toBeInTheDocument()
    // opus-4-5 is a 200k model: 65k used of the 167k usable before auto-compact.
    expect(screen.getByText(/61%/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Workflows/ })).toHaveTextContent("2")
    expect(screen.queryByText("feat/clean-header")).not.toBeInTheDocument()

    const details = await openSessionDetails(user)
    expect(details).toHaveTextContent("thinking")
    expect(details).toHaveTextContent("feat/clean-header")
    expect(details).toHaveTextContent("Duplicated from")
    expect(details).toHaveTextContent("parent-s at turn 3")
    expect(details).toHaveTextContent(/left before compact/)
  })

  it("does not interpret Copilot provider records as Claude context usage", async () => {
    const user = userEvent.setup()
    mocks.session = makeSession({
      agentKind: "copilot",
      rawMessages: [{
        type: "assistant",
        message: {
          model: "claude-sonnet-4.6",
          usage: {
            input_tokens: 50_000,
            output_tokens: 1_000,
            cache_creation_input_tokens: 10_000,
            cache_read_input_tokens: 5_000,
          },
        },
      }],
    })
    mocks.sessionSource = {
      dirName: "copilot__L3RtcC9wcm9qZWN0",
      fileName: "test-session-id/events.jsonl",
      rawText: "",
      agentKind: "copilot",
    }

    renderChrome()

    expect(screen.queryByText(/61%/)).not.toBeInTheDocument()
    const details = await openSessionDetails(user)
    expect(details).not.toHaveTextContent(/left before compact/)
  })

  it("preserves sub-agent navigation and identity", async () => {
    const user = userEvent.setup()
    mocks.sessionSource = {
      dirName: "-tmp-project",
      fileName: "parent/subagents/agent-a1b2c3d4e5.jsonl",
      rawText: "",
      agentKind: "claude",
    }

    renderChrome()

    fireEvent.click(screen.getByRole("button", { name: "Main" }))
    expect(PROPS.onBackToMain).toHaveBeenCalledOnce()

    const details = await openSessionDetails(user)
    expect(details).toHaveTextContent("Agent")
    expect(details).toHaveTextContent("a1b2c3d4")
  })

  it("offers the sidebar toggle only while the sidebar is hidden", () => {
    const { unmount } = renderChrome()
    expect(screen.queryByRole("button", { name: "Show sidebar (\u2318B)" })).not.toBeInTheDocument()
    unmount()

    renderChrome({ showSidebar: false })
    fireEvent.click(screen.getByRole("button", { name: "Show sidebar (\u2318B)" }))
    expect(PROPS.onToggleSidebar).toHaveBeenCalledOnce()
  })

  it("renders no network readout while network access is off", async () => {
    const user = userEvent.setup()
    renderChrome()

    await user.click(screen.getByRole("button", { name: "More actions" }))
    await screen.findByRole("menuitem", { name: "Settings" })

    expect(screen.queryByRole("menuitem", { name: /Copy network URL/ })).not.toBeInTheDocument()
  })

  it("copies the connection URL from the overflow menu while reachable on the network", async () => {
    const user = userEvent.setup()
    mocks.config = {
      networkUrl: "http://10.0.0.4:19384",
      defaultAgentKind: "claude",
      networkAccessDisabled: false,
    }
    mocks.copyToClipboard.mockResolvedValue(true)
    renderChrome()

    await user.click(screen.getByRole("button", { name: "More actions" }))
    await user.click(await screen.findByRole("menuitem", { name: /10\.0\.0\.4/ }))

    expect(mocks.copyToClipboard).toHaveBeenCalledWith("http://10.0.0.4:19384")
    await vi.waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Copied network URL"))
  })

  it("keeps secondary workspace actions in the overflow menu", async () => {
    const user = userEvent.setup()
    renderChrome()

    expect(screen.queryByRole("menuitem", { name: "Settings" })).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "More actions" }))
    await user.click(await screen.findByRole("menuitem", { name: "Settings" }))

    expect(PROPS.onOpenSettings).toHaveBeenCalledOnce()
  })

  it("offers the share control only while a session is open", () => {
    const { unmount } = renderChrome()
    expect(screen.getByRole("button", { name: "Share session" })).toBeInTheDocument()
    unmount()

    mocks.session = null
    renderChrome()
    expect(screen.queryByRole("button", { name: "Share session" })).not.toBeInTheDocument()
  })

  it("withholds the share control from a member who may not share", () => {
    setMe({
      authenticated: true,
      edition: "team",
      user: null,
      capabilities: MEMBER_CAPABILITIES,
    })

    renderChrome()

    expect(screen.queryByRole("button", { name: "Share session" })).not.toBeInTheDocument()
  })

  it("makes an already-shared session visible without opening anything", async () => {
    mocks.authFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{
        sessionId: "test-session-id",
        dirName: "-tmp-project",
        fileName: "test-session-id.jsonl",
        title: "my-session",
        createdAt: Date.now(),
        lastAccessAt: 0,
        guests: 1,
      }],
    })

    renderChrome()

    expect(await screen.findByRole("button", { name: "Session is shared" })).toBeInTheDocument()
  })

  it("opens usage and the server monitor from the overflow menu", async () => {
    const user = userEvent.setup()
    renderChrome()

    await user.click(screen.getByRole("button", { name: "More actions" }))
    await user.click(await screen.findByRole("menuitem", { name: "Usage & cost\u2026" }))
    expect(screen.getByTestId("usage-dialog")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "More actions" }))
    await user.click(await screen.findByRole("menuitem", { name: "Server monitor\u2026" }))
    expect(screen.getByTestId("power-monitor")).toBeInTheDocument()
  })
})

describe("FloatingChrome pull requests", () => {
  const scanned = {
    url: "https://github.com/o/r/pull/777",
    number: 777,
    repo: "o/r",
    title: "Early pull request",
    isDraft: false,
    toolCallId: "toolu_early",
    timestamp: "2026-08-14T09:00:00.000Z",
  }

  beforeEach(() => {
    mocks.config = { networkUrl: null, defaultAgentKind: "claude", networkAccessDisabled: false }
    mocks.session = makeSession()
    mocks.sessionSource = {
      dirName: "-tmp-project",
      fileName: "test-session-id.jsonl",
      rawText: "",
      agentKind: "claude",
    }
    mocks.isLive = false
    mocks.inventorySessions = []
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it("renders pull requests extracted from loaded turns", async () => {
    const user = userEvent.setup()
    mocks.session = makeSession({
      turns: [prTurn("1", 'gh pr create --title "Team Edition"', "https://github.com/o/r/pull/13")],
    })

    renderChrome()
    await openSessionDetails(user)

    const link = screen.getByRole("link", { name: "Pull request #13" })
    expect(link).toHaveAttribute("href", "https://github.com/o/r/pull/13")
    expect(link).toHaveAttribute("target", "_blank")
    expect(link).toHaveTextContent("#13")
    expect(link).toHaveAttribute("title", expect.stringContaining("Team Edition"))
  })

  it("collapses older pull requests into a +N chip", async () => {
    const user = userEvent.setup()
    mocks.session = makeSession({
      turns: [1, 2, 3, 4, 5].map((number) =>
        prTurn(String(number), "gh pr create --fill", `https://github.com/o/r/pull/${number}`)),
    })

    renderChrome()
    await openSessionDetails(user)

    expect(screen.getByText("+2")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Pull request #5" })).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Pull request #1" })).toBeNull()
  })

  it("shows a pull request created before the loaded turns", async () => {
    const user = userEvent.setup()
    withScannedSession("test-session-id", [scanned])

    renderChrome()
    await openSessionDetails(user)

    expect(screen.getByRole("link", { name: "Pull request #777" })).toBeInTheDocument()
  })

  it("ignores scan results belonging to a different session", async () => {
    const user = userEvent.setup()
    withScannedSession("some-other-session", [scanned])

    renderChrome()
    await openSessionDetails(user)

    expect(screen.queryByRole("link", { name: "Pull request #777" })).toBeNull()
  })

  it("does not double up a pull request found by the scan and loaded turns", async () => {
    const user = userEvent.setup()
    withScannedSession("test-session-id", [{
      ...scanned,
      number: 13,
      url: "https://github.com/o/r/pull/13",
    }])
    mocks.session = makeSession({
      turns: [prTurn("1", "gh pr create --fill", "https://github.com/o/r/pull/13")],
    })

    renderChrome()
    await openSessionDetails(user)

    expect(screen.getAllByRole("link", { name: "Pull request #13" })).toHaveLength(1)
  })

  it("combines a scanned older pull request with a freshly created one", async () => {
    const user = userEvent.setup()
    withScannedSession("test-session-id", [scanned])
    mocks.session = makeSession({
      turns: [prTurn("1", "gh pr create --fill", "https://github.com/o/r/pull/778")],
    })

    renderChrome()
    await openSessionDetails(user)

    expect(screen.getByRole("link", { name: "Pull request #777" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Pull request #778" })).toBeInTheDocument()
  })
})
