import type { ComponentProps } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { FloatingChrome } from "@/components/FloatingChrome"
import { __installEditionUiForTest, __resetEditionUiForTest } from "@/edition/registry"
import { setMe, __resetCapabilitiesForTest } from "@/lib/capabilities"
import { getResumeCommand, type AgentKind } from "@/lib/agents"
import { permissionsForAccess, type SessionAccessState } from "@/lib/sessionAccessPermissions"
import { NO_CAPABILITIES } from "../../../shared/contracts/identity"
import type { ActiveSessionInfo } from "@/components/LiveSessions/types"
import type { RawMessage, Turn } from "../../../shared/session/types"
import { computeSessionDigest, EMPTY_SESSION_DIGEST, type SessionView } from "../../../shared/session/sessionDigest"
import { showSession } from "@/__tests__/sessionContextMock"

const mocks = vi.hoisted(() => ({
  config: {
    networkUrl: null as string | null,
    defaultAgentKind: "claude" as const,
    networkAccessDisabled: false,
  },
  sessionSource: null as {
    dirName: string
    fileName: string
    watchOffset: number
    loadId: number
    agentKind?: AgentKind
  } | null,
  isLive: false,
  level: "own" as SessionAccessState,
  handoff: vi.fn(),
  stopSession: vi.fn(),
  copy: vi.fn(),
  dispatch: vi.fn(),
  authFetch: vi.fn(),
  jsonFetch: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toast: vi.fn(),
  inventorySessions: [] as ActiveSessionInfo[],
  setArchived: vi.fn(),
  refreshInventory: vi.fn(),
}))

vi.mock("@/contexts/AppContext", () => ({
  useAppContext: () => ({ config: mocks.config, dispatch: mocks.dispatch }),
}))
vi.mock("@/contexts/SessionContext", async () => (await import("@/__tests__/sessionContextMock")).withSessionHooks({
  useSessionChatContextOptional: () => null,
  useSessionContext: () => ({
    sessionSource: mocks.sessionSource,
    isLive: mocks.isLive,
    permissions: permissionsForAccess(mocks.level),
    actions: { handleProviderHandoff: mocks.handoff, handleStopSession: mocks.stopSession },
  }),
}))
vi.mock("@/contexts/SessionInventoryContext", () => ({
  useSessionInventoryOptional: () => ({
    sessions: mocks.inventorySessions,
    isArchived: (sessionId: string) =>
      Boolean(mocks.inventorySessions.find((s) => s.sessionId === sessionId)?.archived),
    setArchived: mocks.setArchived,
    refresh: mocks.refreshInventory,
  }),
}))
vi.mock("@/hooks/useCopyWithFeedback", () => ({
  useCopyWithFeedback: () => [false, mocks.copy],
}))
vi.mock("@/lib/auth", () => ({
  authFetch: mocks.authFetch,
  jsonFetch: mocks.jsonFetch,
}))
vi.mock("sonner", () => ({
  toast: Object.assign(mocks.toast, { success: mocks.toastSuccess, error: mocks.toastError }),
}))

const PROPS = {
  showSidebar: true,
  sidebarShortcut: "⌘B",
  creatingSession: false,
  onNewSession: vi.fn(),
  onDuplicateSession: vi.fn(),
  onOpenTerminal: vi.fn(),
  onBackToMain: vi.fn(),
  onShowWorkflows: vi.fn(),
  workflowCount: 0,
  onToggleSidebar: vi.fn(),
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

function usage(model: string, inputTokens: number): RawMessage {
  return {
    type: "assistant",
    message: {
      model,
      usage: {
        input_tokens: inputTokens,
        output_tokens: 1_000,
        cache_creation_input_tokens: 10_000,
        cache_read_input_tokens: 5_000,
      },
    },
  } as RawMessage
}

function makeSession(overrides: Partial<SessionView> = {}): SessionView {
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
    digest: EMPTY_SESSION_DIGEST,
    agentKind: "claude",
    ...overrides,
  }
}

function withScannedSession(
  sessionId: string,
  pullRequests: ActiveSessionInfo["pullRequests"],
  extra: Partial<ActiveSessionInfo> = {},
): void {
  mocks.inventorySessions = [{
    dirName: "d",
    projectShortName: "P",
    fileName: "f.jsonl",
    sessionId,
    lastModified: "2026-08-14T10:00:00.000Z",
    size: 1,
    pullRequests,
    ...extra,
  }]
}

function renderChrome(overrides: Partial<ComponentProps<typeof FloatingChrome>> = {}): ReturnType<typeof render> {
  return render(<FloatingChrome {...PROPS} {...overrides} />)
}

function sessionTitle(): HTMLElement {
  return screen.getByRole("button", { name: /Session menu$/ })
}

type User = ReturnType<typeof userEvent.setup>

async function openSessionMenu(user: User): Promise<HTMLElement> {
  await user.click(sessionTitle())
  return screen.findByRole("menu")
}

async function openSessionDetails(user: User): Promise<HTMLElement> {
  const menu = await openSessionMenu(user)
  const details = menu.querySelector<HTMLElement>("[data-session-details]")
  expect(details).not.toBeNull()
  return details as HTMLElement
}

function resetSession(): void {
  mocks.config = { networkUrl: null, defaultAgentKind: "claude", networkAccessDisabled: false }
  showSession(makeSession())
  mocks.sessionSource = {
    dirName: "-tmp-project",
    fileName: "test-session-id.jsonl",
    watchOffset: 0, loadId: 1,
    agentKind: "claude",
  }
  mocks.isLive = false
  mocks.level = "own"
  mocks.inventorySessions = []
  mocks.authFetch.mockResolvedValue({ ok: true, status: 200, json: async () => [] })
  mocks.jsonFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })
}

describe("FloatingChrome", () => {
  beforeEach(() => {
    resetSession()
    window.history.replaceState({}, "", "/")
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    __resetCapabilitiesForTest()
    __resetEditionUiForTest()
  })

  it("names the session by project and title, falling back to its slug", () => {
    renderChrome()
    expect(sessionTitle()).toHaveAccessibleName("project / my-session. Session menu")
  })

  it("names the session by its real title once the inventory has one", () => {
    withScannedSession("test-session-id", [], { aiTitle: "Tidy the header" })
    renderChrome()
    expect(sessionTitle()).toHaveAccessibleName("project / Tidy the header. Session menu")
  })

  it("keeps provider handoff inside the session menu", async () => {
    const user = userEvent.setup()
    renderChrome()
    expect(screen.queryByText("Continue with another provider…")).not.toBeInTheDocument()
    await openSessionMenu(user)
    await user.click(await screen.findByRole("menuitem", { name: "Continue with another provider…" }))
    expect(mocks.handoff).toHaveBeenCalledOnce()
  })

  it.each(["view", "none"] as const)("withholds provider handoff for %s access", async (level) => {
    mocks.level = level
    const user = userEvent.setup()
    renderChrome()
    await openSessionMenu(user)
    expect(screen.queryByRole("menuitem", { name: "Continue with another provider…" })).not.toBeInTheDocument()
  })

  it("owns the window-drag strip and paints it under the title row", () => {
    const { container } = renderChrome()

    // The strip has to be a sibling of the title row, and lower: anywhere else
    // (a resizable panel, say) it lands in its own stacking context and covers
    // the title instead of sitting behind it.
    const strip = container.querySelector(".drag-strip")
    const titleRow = sessionTitle().closest(".pointer-events-auto")?.parentElement
    expect(strip).toBeInTheDocument()
    expect(strip).toHaveClass("z-10")
    expect(titleRow).toHaveClass("z-30")
    expect(strip?.parentElement).toBe(titleRow?.parentElement)
    expect(strip?.compareDocumentPosition(titleRow as Node))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it("hands the sticky prompt a slot between the title and the session's actions", () => {
    const promptSlotRef = vi.fn()
    renderChrome({ promptSlotRef })

    const slot = promptSlotRef.mock.calls.at(-1)?.[0] as HTMLElement
    expect(slot).toBeInstanceOf(HTMLElement)
    expect(sessionTitle().compareDocumentPosition(slot)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it("copies the resume command from the session menu", async () => {
    const user = userEvent.setup()
    renderChrome()

    await openSessionMenu(user)
    await user.click(screen.getByRole("menuitem", { name: "Copy resume command" }))

    expect(mocks.copy).toHaveBeenCalledWith(
      getResumeCommand("claude", "test-session-id", "/tmp/project"),
    )
  })

  it("opens every session and project operation from the title", async () => {
    const user = userEvent.setup()
    renderChrome()

    await openSessionMenu(user)

    expect(screen.getByRole("menuitem", { name: "Copy resume command" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "New session in this project" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Duplicate this session" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Share session…" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Open project in editor" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Reveal in file manager" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Open terminal in project" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "View all sessions in this project" })).toBeInTheDocument()

    await user.click(screen.getByRole("menuitem", { name: "Duplicate this session" }))
    expect(PROPS.onDuplicateSession).toHaveBeenCalledOnce()
  })

  it("offers a member without host access none of the host's project actions", async () => {
    setMe({
      authenticated: true,
      edition: "team",
      user: { id: "u_1", username: "alice", displayName: "Alice" },
      capabilities: NO_CAPABILITIES,
    })
    const user = userEvent.setup()
    renderChrome()

    await openSessionMenu(user)

    expect(screen.getByRole("menuitem", { name: "New session in this project" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "View all sessions in this project" })).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Open project in editor" })).not.toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Reveal in file manager" })).not.toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Open terminal in project" })).not.toBeInTheDocument()
  })

  it("preserves project action request and project-session navigation semantics", async () => {
    const user = userEvent.setup()
    renderChrome()

    await openSessionMenu(user)
    await user.click(screen.getByRole("menuitem", { name: "Open project in editor" }))

    expect(mocks.jsonFetch).toHaveBeenCalledWith("/api/open-in-editor", {
      path: "/tmp/project",
      dirName: "-tmp-project",
    })

    await openSessionMenu(user)
    await user.click(screen.getByRole("menuitem", { name: "View all sessions in this project" }))

    expect(mocks.dispatch).toHaveBeenNthCalledWith(1, { type: "GO_HOME", isMobile: false })
    expect(mocks.dispatch).toHaveBeenNthCalledWith(2, {
      type: "SET_DASHBOARD_PROJECT",
      dirName: "-tmp-project",
    })
  })

  it("keeps the session's state to the top of its menu", async () => {
    const user = userEvent.setup()
    const thinkingTurn = prTurn("thinking", "echo ok", "ok")
    thinkingTurn.thinking = [{ type: "thinking", thinking: "Working", signature: "sig" }]
    showSession(makeSession({
      model: "claude-opus-4-5",
      gitBranch: "feat/clean-header",
      turns: [thinkingTurn],
      branchedFrom: { sessionId: "parent-session", turnIndex: 2 },
      digest: computeSessionDigest([usage("claude-opus-4-5", 50_000)]),
    }))
    mocks.isLive = true

    renderChrome({ workflowCount: 2 })

    // The composer's model picker shows the model; the title keeps it to its menu.
    expect(screen.queryByText("Opus 4.5")).not.toBeInTheDocument()
    expect(screen.getByLabelText("Session is live")).toBeInTheDocument()
    // opus-4-5 is a 200k model: 65k used of the 167k usable leaves 61%, which only the menu reports.
    expect(screen.queryByText(/61%/)).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Workflows/ })).toHaveTextContent("2")
    expect(screen.queryByText("feat/clean-header")).not.toBeInTheDocument()

    const details = await openSessionDetails(user)
    expect(details).toHaveTextContent("Opus 4.5")
    expect(details).toHaveTextContent("thinking")
    expect(details).toHaveTextContent("feat/clean-header")
    expect(details).toHaveTextContent("Duplicated from")
    expect(details).toHaveTextContent("parent-s at turn 3")
    expect(details).toHaveTextContent(/left before compact/)
  })

  it("leaves the context reading to the composer, even once context runs low", () => {
    showSession(makeSession({
      model: "claude-opus-4-5",
      digest: computeSessionDigest([usage("claude-opus-4-5", 140_000)]),
    }))

    renderChrome()

    // 155k used of the 167k usable before auto-compact.
    expect(screen.queryByText(/^\d+%$/)).not.toBeInTheDocument()
  })

  it("does not interpret Copilot provider records as Claude context usage", async () => {
    const user = userEvent.setup()
    showSession(makeSession({
      agentKind: "copilot",
      model: "claude-sonnet-4.6",
      digest: computeSessionDigest([usage("claude-sonnet-4.6", 140_000)]),
    }))
    mocks.sessionSource = {
      dirName: "copilot__L3RtcC9wcm9qZWN0",
      fileName: "test-session-id/events.jsonl",
      watchOffset: 0, loadId: 1,
      agentKind: "copilot",
    }

    renderChrome()

    expect(screen.queryByText(/^\d+%$/)).not.toBeInTheDocument()
    const details = await openSessionDetails(user)
    expect(details).not.toHaveTextContent(/left before compact/)
  })

  it("preserves sub-agent navigation and identity", async () => {
    const user = userEvent.setup()
    mocks.sessionSource = {
      dirName: "-tmp-project",
      fileName: "parent/subagents/agent-a1b2c3d4e5.jsonl",
      watchOffset: 0, loadId: 1,
      agentKind: "claude",
    }

    renderChrome()

    await user.click(screen.getByRole("button", { name: "Main" }))
    expect(PROPS.onBackToMain).toHaveBeenCalledOnce()

    const details = await openSessionDetails(user)
    expect(details).toHaveTextContent("Agent")
    expect(details).toHaveTextContent("a1b2c3d4")
  })

  it("offers the sidebar toggle only while the sidebar is hidden", async () => {
    const { unmount } = renderChrome()
    expect(screen.queryByRole("button", { name: "Show sidebar (⌘B)" })).not.toBeInTheDocument()
    unmount()

    renderChrome({ showSidebar: false })
    await userEvent.click(screen.getByRole("button", { name: "Show sidebar (⌘B)" }))
    expect(PROPS.onToggleSidebar).toHaveBeenCalledOnce()
  })

  it("stops a live session from its menu", async () => {
    const user = userEvent.setup()
    mocks.isLive = true
    renderChrome()

    await openSessionMenu(user)
    await user.click(screen.getByRole("menuitem", { name: "Stop session" }))

    expect(mocks.stopSession).toHaveBeenCalledOnce()
  })

  it("offers Stop session only for a live process the user may drive and the agent can stop", async () => {
    const user = userEvent.setup()
    const cases: Array<() => void> = [
      () => { mocks.isLive = false },
      () => { mocks.isLive = true; mocks.level = "view" },
      () => {
        mocks.isLive = true
        mocks.sessionSource = { dirName: "codex__L3RtcC9wcm9qZWN0", fileName: "s.jsonl", watchOffset: 0, loadId: 1 }
      },
    ]
    for (const arrange of cases) {
      resetSession()
      arrange()
      renderChrome()
      await openSessionMenu(user)
      expect(screen.queryByRole("menuitem", { name: "Stop session" })).not.toBeInTheDocument()
      cleanup()
    }
  })

  it("shows no share button for an unshared session until the menu opens it", async () => {
    const user = userEvent.setup()
    renderChrome()
    expect(screen.queryByRole("button", { name: "Share session" })).not.toBeInTheDocument()

    await openSessionMenu(user)
    await user.click(screen.getByRole("menuitem", { name: "Share session…" }))

    expect(await screen.findByRole("button", { name: "Enable sharing" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Share session" })).toBeInTheDocument()
  })

  // The share route only accepts agents whose transcripts it can publish, so
  // offering the control anywhere else just produced a 400 on click.
  it.each([
    ["-Users-me-proj", true],
    ["codex__L3RtcC9wcm9qZWN0", true],
    ["copilot__L3RtcC9wcm9qZWN0", false],
  ])("offers sharing in %s only when the agent can be shared", async (dirName, shareable) => {
    const user = userEvent.setup()
    mocks.sessionSource = { dirName, fileName: "s.jsonl", watchOffset: 0, loadId: 1 }

    renderChrome()
    await openSessionMenu(user)

    const item = screen.queryByRole("menuitem", { name: "Share session…" })
    if (shareable) expect(item).toBeInTheDocument()
    else expect(item).not.toBeInTheDocument()
  })

  it("withholds sharing from a member who may not share", async () => {
    setMe({
      authenticated: true,
      edition: "team",
      user: null,
      capabilities: NO_CAPABILITIES,
    })
    const user = userEvent.setup()

    renderChrome()
    await openSessionMenu(user)

    expect(screen.queryByRole("menuitem", { name: "Share session…" })).not.toBeInTheDocument()
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

  it("keeps only the drag strip and sidebar toggle off the conversation view", () => {
    withScannedSession("test-session-id", [])
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
    __installEditionUiForTest({
      SessionHeaderActions: ({ sessionId }: { sessionId: string }) => <button>Act on {sessionId}</button>,
    })
    const { container } = renderChrome({ showSession: false, showSidebar: false, workflowCount: 2 })

    expect(container.querySelector(".drag-strip")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Show sidebar (\u2318B)" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Session menu$/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Workflows/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Act on/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Share session|Session is shared/ })).not.toBeInTheDocument()
    expect(screen.getAllByRole("button")).toHaveLength(1)
  })

  it("renders nothing about a session while none is open", () => {
    showSession(null)
    renderChrome()
    expect(screen.queryByRole("button", { name: /Session menu$/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Share session|Session is shared/ })).not.toBeInTheDocument()
  })

  it("carries the edition's actions for the open session, never for a sub-agent view", () => {
    const SessionHeaderActions = ({ sessionId }: { sessionId: string }) => <button>Act on {sessionId}</button>
    renderChrome()
    expect(screen.queryByRole("button", { name: /Act on/ })).not.toBeInTheDocument()
    cleanup()

    __installEditionUiForTest({ SessionHeaderActions })
    const { unmount } = renderChrome()
    expect(screen.getByRole("button", { name: "Act on test-session-id" })).toBeInTheDocument()
    unmount()

    // Access follows the root session, so a sub-agent view has nothing to act on.
    mocks.sessionSource = {
      dirName: "-tmp-project",
      fileName: "test-session-id/subagents/agent-abc.jsonl",
      watchOffset: 0, loadId: 1,
      agentKind: "claude",
    }
    renderChrome()
    expect(screen.queryByRole("button", { name: /Act on/ })).not.toBeInTheDocument()
  })
})

describe("FloatingChrome archive", () => {
  beforeEach(resetSession)

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it.each(["view", "interact", "unknown"] as const)("withholds archiving while access is %s", async (level) => {
    mocks.level = level
    const user = userEvent.setup()
    renderChrome()

    await openSessionMenu(user)

    expect(screen.queryByRole("menuitem", { name: /rchive/ })).not.toBeInTheDocument()
  })

  it("archives the open session, refreshes the inventory and offers an undo", async () => {
    const user = userEvent.setup()
    renderChrome()

    await openSessionMenu(user)
    await user.click(screen.getByRole("menuitem", { name: "Archive session" }))

    expect(mocks.setArchived).toHaveBeenCalledWith(["test-session-id"], true)
    await vi.waitFor(() => expect(mocks.jsonFetch).toHaveBeenCalledWith(
      "/api/archive-sessions",
      { sessionIds: ["test-session-id"], archived: true },
    ))
    await vi.waitFor(() => expect(mocks.refreshInventory).toHaveBeenCalled())
    expect(mocks.toast).toHaveBeenCalledWith("Session archived", expect.objectContaining({
      action: expect.objectContaining({ label: "Undo" }),
    }))
  })

  it("rolls back when the server refuses", async () => {
    mocks.jsonFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    const user = userEvent.setup()
    renderChrome()

    await openSessionMenu(user)
    await user.click(screen.getByRole("menuitem", { name: "Archive session" }))

    await vi.waitFor(() => expect(mocks.setArchived).toHaveBeenCalledWith(["test-session-id"], false))
    expect(mocks.toastError).toHaveBeenCalledWith("Could not archive session")
    expect(mocks.refreshInventory).not.toHaveBeenCalled()
  })

  it("restores an archived session instead", async () => {
    withScannedSession("test-session-id", undefined, { archived: true, archivedReason: "manual" })
    const user = userEvent.setup()
    renderChrome()

    await openSessionMenu(user)
    expect(screen.queryByRole("menuitem", { name: "Archive session" })).not.toBeInTheDocument()
    await user.click(screen.getByRole("menuitem", { name: "Restore from archive" }))

    await vi.waitFor(() => expect(mocks.jsonFetch).toHaveBeenCalledWith(
      "/api/archive-sessions",
      { sessionIds: ["test-session-id"], archived: false },
    ))
  })

  it("explains that a live session has to stop first", async () => {
    mocks.isLive = true
    const user = userEvent.setup()
    renderChrome()

    const menu = await openSessionMenu(user)
    const item = within(menu).getByRole("menuitem", { name: "Archive session" })
    expect(item).toHaveAttribute("aria-disabled", "true")
    expect(item).toHaveAttribute("title", "Stop the session before archiving it")
  })

  it("withholds archiving from a sub-agent view", async () => {
    mocks.sessionSource = { dirName: "-tmp-project", fileName: "parent-id/subagents/agent-abc.jsonl", watchOffset: 0, loadId: 1, agentKind: "claude" }
    const user = userEvent.setup()
    renderChrome()

    await openSessionMenu(user)

    expect(screen.queryByRole("menuitem", { name: /rchive/ })).not.toBeInTheDocument()
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

  beforeEach(resetSession)

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it("renders pull requests extracted from loaded turns", async () => {
    const user = userEvent.setup()
    showSession(makeSession({
      turns: [prTurn("1", 'gh pr create --title "Team Edition"', "https://github.com/o/r/pull/13")],
    }))

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
    showSession(makeSession({
      turns: [1, 2, 3, 4, 5].map((number) =>
        prTurn(String(number), "gh pr create --fill", `https://github.com/o/r/pull/${number}`)),
    }))

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
    showSession(makeSession({ model: "claude-opus-4-5" }))

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
    showSession(makeSession({
      turns: [prTurn("1", "gh pr create --fill", "https://github.com/o/r/pull/13")],
    }))

    renderChrome()
    await openSessionDetails(user)

    expect(screen.getAllByRole("link", { name: "Pull request #13" })).toHaveLength(1)
  })

  it("combines a scanned older pull request with a freshly created one", async () => {
    const user = userEvent.setup()
    withScannedSession("test-session-id", [scanned])
    showSession(makeSession({
      turns: [prTurn("1", "gh pr create --fill", "https://github.com/o/r/pull/778")],
    }))

    renderChrome()
    await openSessionDetails(user)

    expect(screen.getByRole("link", { name: "Pull request #777" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Pull request #778" })).toBeInTheDocument()
  })
})
