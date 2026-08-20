import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DesktopHeader } from "@/components/DesktopHeader"
import { getResumeCommand } from "@/lib/sessionSource"
import type { ActiveSessionInfo } from "@/components/LiveSessions/types"
import type { ParsedSession, Turn } from "@/lib/types"

const mocks = vi.hoisted(() => ({
  config: { networkUrl: null as string | null, defaultAgentKind: "claude" as const },
  session: null as ParsedSession | null,
  sessionSource: null as {
    dirName: string
    fileName: string
    rawText: string
    agentKind?: "claude" | "codex"
  } | null,
  isLive: false,
  copy: vi.fn(),
  dispatch: vi.fn(),
  authFetch: vi.fn(),
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
vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))
vi.mock("@/components/TokenUsageWidget", () => ({ TokenUsageIndicator: () => null }))
vi.mock("@/components/LeakIndicator", () => ({ LeakIndicator: () => null }))
vi.mock("@/components/PowerMonitor", () => ({ PowerMonitor: () => null }))
vi.mock("@/components/DeviceSwitcher", () => ({ DeviceSwitcher: () => null }))
vi.mock("@/components/MissionControl/MissionControlButton", () => ({
  MissionControlButton: () => null,
}))

const PROPS = {
  showSidebar: true,
  showStats: false,
  killing: false,
  creatingSession: false,
  onGoHome: vi.fn(),
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
  onOpenCommandPalette: vi.fn(),
  commandPaletteShortcut: "⌘K",
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
      totalCostUSD: 0,
      toolCallCounts: {},
      errorCount: 0,
      totalDurationMs: 0,
      turnCount: 0,
    },
    rawMessages: [],
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

function renderHeader(): ReturnType<typeof render> {
  return render(<DesktopHeader {...PROPS} />)
}

describe("DesktopHeader", () => {
  beforeEach(() => {
    mocks.config = { networkUrl: null, defaultAgentKind: "claude" }
    mocks.session = makeSession()
    mocks.sessionSource = {
      dirName: "-tmp-project",
      fileName: "test-session-id.jsonl",
      rawText: "",
      agentKind: "claude",
    }
    mocks.isLive = false
    mocks.inventorySessions = []
    mocks.authFetch.mockResolvedValue({ ok: true })
    window.history.replaceState({}, "", "/")
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it("copies the resume command from the project/session breadcrumb", () => {
    renderHeader()

    fireEvent.click(screen.getByRole("button", { name: /my-session/ }))

    expect(mocks.copy).toHaveBeenCalledWith(
      getResumeCommand("claude", "test-session-id", "/tmp/project"),
    )
    expect(screen.getByText("project")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Copy resume command" })).not.toBeInTheDocument()
  })

  it("opens all six session operations from the breadcrumb context menu", async () => {
    renderHeader()

    fireEvent.contextMenu(screen.getByRole("button", { name: /my-session/ }))

    expect(await screen.findByRole("menuitem", { name: "New session in this project" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Duplicate this session" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Open project in editor" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Reveal in file manager" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Open terminal in project" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "View all sessions in this project" })).toBeInTheDocument()
  })

  it("preserves project action request and project-session navigation semantics", async () => {
    renderHeader()
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

  it("shows the session state that used to occupy the two lower bars", () => {
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

    render(<DesktopHeader {...PROPS} workflowCount={2} />)

    expect(screen.getByText("opus")).toBeInTheDocument()
    expect(screen.getByText("thinking")).toBeInTheDocument()
    expect(screen.getByText("feat/clean-header")).toBeInTheDocument()
    expect(screen.getByText("Duplicated")).toBeInTheDocument()
    expect(screen.getByLabelText("Session is live")).toBeInTheDocument()
    expect(screen.getByText(/93%/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Workflows/ })).toHaveTextContent("2")
  })

  it("preserves sub-agent navigation and identity", () => {
    mocks.sessionSource = {
      dirName: "-tmp-project",
      fileName: "parent/subagents/agent-a1b2c3d4e5.jsonl",
      rawText: "",
      agentKind: "claude",
    }

    renderHeader()

    fireEvent.click(screen.getByRole("button", { name: "Main" }))
    expect(PROPS.onBackToMain).toHaveBeenCalledOnce()
    expect(screen.getByText("Agent a1b2c3d4")).toBeInTheDocument()
  })

  it("renders no network readout while network access is off", () => {
    renderHeader()

    expect(screen.queryByText("Network off")).not.toBeInTheDocument()
  })

  it("shows the connection URL while the machine is reachable on the network", () => {
    mocks.config = { networkUrl: "http://10.0.0.4:19384", defaultAgentKind: "claude" }
    renderHeader()

    fireEvent.click(screen.getByRole("button", { name: /10\.0\.0\.4/ }))

    expect(mocks.copy).toHaveBeenCalledWith("http://10.0.0.4:19384")
  })

  it("keeps secondary workspace actions in the overflow menu", async () => {
    const user = userEvent.setup()
    render(<DesktopHeader {...PROPS} />)

    expect(screen.queryByRole("menuitem", { name: "Settings" })).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "More actions" }))
    await user.click(await screen.findByRole("menuitem", { name: "Settings" }))

    expect(PROPS.onOpenSettings).toHaveBeenCalledOnce()
  })
})

describe("DesktopHeader pull requests", () => {
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
    mocks.config = { networkUrl: null, defaultAgentKind: "claude" }
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

  it("renders pull requests extracted from loaded turns", () => {
    mocks.session = makeSession({
      turns: [prTurn("1", 'gh pr create --title "Team Edition"', "https://github.com/o/r/pull/13")],
    })

    renderHeader()

    const link = screen.getByRole("link", { name: "Pull request #13" })
    expect(link).toHaveAttribute("href", "https://github.com/o/r/pull/13")
    expect(link).toHaveAttribute("target", "_blank")
    expect(link).toHaveTextContent("#13")
    expect(link).toHaveAttribute("title", expect.stringContaining("Team Edition"))
  })

  it("collapses older pull requests into a +N chip", () => {
    mocks.session = makeSession({
      turns: [1, 2, 3, 4, 5].map((number) =>
        prTurn(String(number), "gh pr create --fill", `https://github.com/o/r/pull/${number}`)),
    })

    renderHeader()

    expect(screen.getByText("+2")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Pull request #5" })).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Pull request #1" })).toBeNull()
  })

  it("shows a pull request created before the loaded turns", () => {
    withScannedSession("test-session-id", [scanned])

    renderHeader()

    expect(screen.getByRole("link", { name: "Pull request #777" })).toBeInTheDocument()
  })

  it("ignores scan results belonging to a different session", () => {
    withScannedSession("some-other-session", [scanned])

    renderHeader()

    expect(screen.queryByRole("link", { name: "Pull request #777" })).toBeNull()
  })

  it("does not double up a pull request found by the scan and loaded turns", () => {
    withScannedSession("test-session-id", [{
      ...scanned,
      number: 13,
      url: "https://github.com/o/r/pull/13",
    }])
    mocks.session = makeSession({
      turns: [prTurn("1", "gh pr create --fill", "https://github.com/o/r/pull/13")],
    })

    renderHeader()

    expect(screen.getAllByRole("link", { name: "Pull request #13" })).toHaveLength(1)
  })

  it("combines a scanned older pull request with a freshly created one", () => {
    withScannedSession("test-session-id", [scanned])
    mocks.session = makeSession({
      turns: [prTurn("1", "gh pr create --fill", "https://github.com/o/r/pull/778")],
    })

    renderHeader()

    expect(screen.getByRole("link", { name: "Pull request #777" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Pull request #778" })).toBeInTheDocument()
  })
})
