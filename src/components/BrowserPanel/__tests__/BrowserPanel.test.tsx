import type { ComponentProps } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { BrowserPanel } from "@/components/BrowserPanel"
import type { UseBrowserSessions } from "@/hooks/useBrowserSessions"
import type { BrowserFrame, BrowserSocketStatus, UseBrowserSocket } from "@/hooks/useBrowserSocket"
import type { WorkspacePanelContext } from "@/plugin-api"
import type { BrowserClientMessage, BrowserTab } from "../../../../shared/browser/protocol"
import type { BrowserSessionInfo, BrowserSkillTarget } from "../../../../shared/browser/types"
import { AGENT_KINDS } from "../../../../shared/session/agent-descriptors"
import type { ParsedSession, ToolCall, Turn } from "../../../../shared/session/types"

vi.mock("@/hooks/useBrowserSessions", () => ({
  useBrowserSessions: (enabled: boolean) => sessionsDouble(enabled),
}))
vi.mock("@/hooks/useBrowserSocket", async (importOriginal) => ({
  // `releaseFrame` stays real: the viewport frees the frames it is handed.
  ...(await importOriginal<typeof import("@/hooks/useBrowserSocket")>()),
  useBrowserSocket: (session: string | null) => socketDouble(session),
}))
// Wrapped in the same memo the panel relies on, so a re-render here means the
// panel handed the bar something new — the frame path must not do that.
vi.mock("@/components/BrowserPanel/BrowserSessionBar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/BrowserPanel/BrowserSessionBar")>()
  const { createElement, memo } = await import("react")
  return {
    ...actual,
    BrowserSessionBar: memo((props: ComponentProps<typeof actual.BrowserSessionBar>) => {
      sessionBarRenders += 1
      return createElement(actual.BrowserSessionBar, props)
    }),
  }
})

// ── Hook doubles ─────────────────────────────────────────────────────────

const send = vi.fn<(message: BrowserClientMessage) => void>()
/** Labels come from the server, so the panel never spells a CLI itself. */
const SKILL_TARGETS: BrowserSkillTarget[] = [
  { kind: AGENT_KINDS[0], label: "First CLI", configRoot: "/home/me/.first", installed: true, automatic: true },
  { kind: AGENT_KINDS[1], label: "Second CLI", configRoot: "/home/me/.second", installed: false, automatic: false },
]
const installSkill = vi.fn(async () => ({ ok: true as const, paths: ["/home/me/.second/skills/cogpit-browser"] }))
const readSkillTargets = vi.fn(async () => ({ ok: true as const, targets: SKILL_TARGETS }))
const remove = vi.fn(async () => ({ ok: true as const }))
const stop = vi.fn(async () => ({ ok: true as const }))
const noop = vi.fn(async () => ({ ok: true as const }))
const closePanel = vi.fn()
const socketSessions: (string | null)[] = []

let installed = true
let browsers: BrowserSessionInfo[] = []
let socketState: "not-installed" | "stopped" | "connecting" | "live" = "live"
let socketStatus: BrowserSocketStatus = "connected"
let socketError: string | null = null
let listError: string | null = null
let lastFrameAt: number | null = null
let frame: BrowserFrame | null = null
let tabs: BrowserTab[] = []
let sessionBarRenders = 0

function sessionsDouble(enabled: boolean): UseBrowserSessions {
  return {
    status: enabled
      ? { installed, binaryPath: installed ? "/usr/local/bin/agent-browser" : null, sessions: browsers }
      : null,
    error: listError,
    create: noop,
    remove,
    stop,
    readSkillTargets,
    installSkill,
  }
}

function socketDouble(session: string | null): UseBrowserSocket {
  socketSessions.push(session)
  return {
    status: session === null ? "idle" : socketStatus,
    state: session === null ? null : { type: "status", state: socketState, session },
    page: null,
    tabs,
    followed: null,
    frame,
    lastFrameAt,
    error: socketError,
    send,
  }
}

function frameOf(ts: number): BrowserFrame {
  return {
    bitmap: { close: () => {} } as unknown as ImageBitmap,
    header: {
      deviceWidth: 1280,
      deviceHeight: 720,
      pageScaleFactor: 1,
      offsetTop: 0,
      scrollOffsetX: 0,
      scrollOffsetY: 0,
      targetId: "target-1",
      ts,
    },
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────

function browserOf(overrides: Partial<BrowserSessionInfo> = {}): BrowserSessionInfo {
  return {
    name: "default",
    isDefault: true,
    running: true,
    note: null,
    createdAt: null,
    lastUsedAt: null,
    lastUrl: null,
    driverSessionId: null,
    ...overrides,
  }
}

const WORK = browserOf({ name: "work", isDefault: false })
const SHOP = browserOf({ name: "shop", isDefault: false })

function sessionDriving(command: string, done = true): ParsedSession {
  const call: ToolCall = {
    id: "tool-1",
    name: "Bash",
    input: { command },
    result: done ? "ok" : null,
    isError: false,
    timestamp: "2026-09-06T10:00:00.000Z",
  }
  const turn: Turn = {
    id: "turn-1",
    userMessage: null,
    contentBlocks: [],
    thinking: [],
    assistantText: [],
    toolCalls: [call],
    subAgentActivity: [],
    timestamp: "2026-09-06T10:00:00.000Z",
    durationMs: null,
    tokenUsage: null,
    model: null,
  }
  return {
    sessionId: "cogpit-1",
    version: "1",
    gitBranch: "browser-panel",
    cwd: "/repo",
    slug: "",
    name: "",
    model: "",
    turns: [turn],
    stats: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      toolCallCounts: {},
      errorCount: 0,
      totalDurationMs: 0,
      turnCount: 1,
    },
    rawMessages: [],
  }
}

function contextOf(session: ParsedSession | null = null): WorkspacePanelContext {
  return {
    session,
    sessionChangeKey: 0,
    projectPath: "/repo",
    hasFileChanges: false,
    canAccessHostFiles: true,
  }
}

function panel(context = contextOf()) {
  return <BrowserPanel context={context} active closePanel={closePanel} />
}

function setup(context = contextOf()) {
  const user = userEvent.setup()
  return { user, ...render(panel(context)) }
}

function selectedName(): string {
  return screen.getByRole("button", { name: "Switch browser" }).textContent ?? ""
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  socketSessions.length = 0
  installed = true
  browsers = [browserOf()]
  socketState = "live"
  socketStatus = "connected"
  socketError = null
  listError = null
  lastFrameAt = Date.now()
  frame = null
  tabs = []
  sessionBarRenders = 0
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => {}) },
  })
})

describe("BrowserPanel", () => {
  it("sends the chosen tab id when closing a tab", async () => {
    tabs = [{ targetId: "t2", url: "https://example.test", title: "Example" }]
    const { user } = setup()
    await user.click(screen.getByRole("button", { name: "Close tab: Example" }))
    expect(send).toHaveBeenCalledWith({ type: "close-tab", targetId: "t2" })
    expect(closePanel).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
  })

  it("offers the install command and the agent skill when the CLI is missing", async () => {
    installed = false
    const { user } = setup()

    expect(screen.getByText("npm i -g agent-browser && agent-browser install")).toBeInTheDocument()
    expect(screen.queryByRole("application", { name: "Browser viewport" })).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Copy install command" }))
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /install the agent skill/i }))
    expect(await screen.findByRole("heading", { name: "Agent skill" })).toBeInTheDocument()
    // Opening the dialog is not installing: nothing is written until a row is clicked.
    expect(installSkill).not.toHaveBeenCalled()
  })

  it("opens the agent skill dialog from the session bar and installs one CLI", async () => {
    const { user } = setup()

    await user.click(screen.getByRole("button", { name: "Switch browser" }))
    await user.click(await screen.findByRole("menuitem", { name: "Agent skill…" }))

    expect(await screen.findByRole("heading", { name: "Agent skill" })).toBeInTheDocument()
    for (const target of SKILL_TARGETS) {
      expect(screen.getByText(target.label)).toBeInTheDocument()
      expect(screen.getByText(target.configRoot)).toBeInTheDocument()
    }
    // The one already installed offers nothing to click; the other does.
    expect(screen.queryByRole("button", { name: "Install for First CLI" })).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Install for Second CLI" }))
    expect(installSkill).toHaveBeenCalledWith(AGENT_KINDS[1])
  })

  it("opens a page from the stopped state, prefilled with the last one", async () => {
    socketState = "stopped"
    browsers = [browserOf({ lastUrl: "https://last.example" })]
    const { user } = setup()

    expect(screen.getByText(/isn.t running/)).toBeInTheDocument()
    const field = screen.getByLabelText("Page to open")
    expect(field).toHaveValue("https://last.example")

    await user.clear(field)
    await user.type(field, "example.com")
    await user.click(screen.getByRole("button", { name: "Open" }))

    expect(send).toHaveBeenCalledWith({ type: "launch", url: "example.com" })
  })

  it("says what it is waiting for while connecting", () => {
    socketState = "connecting"
    setup()

    expect(screen.getByRole("status")).toHaveTextContent("Connecting to default")
    expect(screen.queryByRole("application", { name: "Browser viewport" })).not.toBeInTheDocument()
  })

  it("reports the stream in the nav bar, not over the page", () => {
    const { rerender } = setup()

    const viewport = screen.getByRole("application", { name: "Browser viewport" })
    expect(screen.getByLabelText("Page URL")).toBeInTheDocument()
    expect(screen.getByText("LIVE")).toBeInTheDocument()
    // Nothing the panel draws sits on top of the page.
    expect(viewport.parentElement?.textContent).not.toContain("LIVE")

    lastFrameAt = Date.now() - 10_000
    rerender(panel())
    expect(screen.getByText("IDLE")).toBeInTheDocument()
  })

  it("follows the agent to another browser that exists", async () => {
    browsers = [browserOf(), WORK]
    setup(contextOf(sessionDriving("agent-browser --session work open https://example.com")))

    await waitFor(() => expect(selectedName()).toContain("work"))
    expect(socketSessions).toContain("work")
  })

  it("leaves an unknown browser alone", async () => {
    browsers = [browserOf()]
    setup(contextOf(sessionDriving("agent-browser --session ghost open https://example.com")))

    await waitFor(() => expect(selectedName()).toContain("default"))
    expect(socketSessions).not.toContain("ghost")
  })

  it("keeps a browser the user just picked, even while following", async () => {
    browsers = [browserOf(), WORK, SHOP]
    const { user, rerender } = setup()

    await user.click(screen.getByRole("button", { name: "Switch browser" }))
    await user.click(await screen.findByRole("menuitemradio", { name: /^shop/ }))
    await waitFor(() => expect(selectedName()).toContain("shop"))

    rerender(panel(contextOf(sessionDriving("agent-browser --session work open https://example.com"))))

    await waitFor(() => expect(selectedName()).toContain("shop"))
    expect(socketSessions).not.toContain("work")
  })

  it("captions the page only while the agent drives the browser on screen", async () => {
    browsers = [browserOf(), WORK]
    const { user, rerender } = setup(
      contextOf(sessionDriving("agent-browser open https://example.com", false)),
    )

    expect(screen.getByText("agent-browser open https://example.com")).toBeInTheDocument()
    expect(screen.getByText("running")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Follow agent" }))
    rerender(panel(contextOf(sessionDriving("agent-browser --session work snapshot"))))

    expect(selectedName()).toContain("default")
    expect(screen.queryByText("agent-browser --session work snapshot")).not.toBeInTheDocument()
  })

  it("says the connection dropped rather than passing a frozen page off as live", () => {
    socketStatus = "disconnected"
    frame = frameOf(1)
    setup()

    expect(screen.getByText("Reconnecting…")).toBeInTheDocument()
    expect(screen.getByText("OFFLINE")).toBeInTheDocument()
    expect(screen.queryByText("LIVE")).not.toBeInTheDocument()
    // The last frame is worth more than a black pane while the socket retries.
    expect(screen.getByRole("application", { name: "Browser viewport" })).toBeInTheDocument()
  })

  it("stays quiet about the socket before the first page arrives", () => {
    socketState = "connecting"
    socketStatus = "connecting"
    setup()

    expect(screen.queryByText("Reconnecting…")).not.toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("Connecting to default")
  })

  it("reports a browser list it could not read", () => {
    listError = "Could not read the browser list (500)"
    setup()

    expect(screen.getByText("Could not read the browser list (500)")).toBeInTheDocument()
  })

  it("keeps the session bar out of the frame path", () => {
    const { rerender } = setup()
    const before = sessionBarRenders
    expect(before).toBeGreaterThan(0)

    frame = frameOf(2)
    rerender(panel())
    frame = frameOf(3)
    rerender(panel())

    expect(sessionBarRenders).toBe(before)
  })

  it("reports a socket failure beside the page instead of replacing it", async () => {
    socketError = "Could not attach to the page"
    const { user } = setup()

    expect(screen.getByRole("application", { name: "Browser viewport" })).toBeInTheDocument()
    expect(screen.getByText("Could not attach to the page")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Dismiss" }))

    expect(screen.queryByText("Could not attach to the page")).not.toBeInTheDocument()
    expect(screen.getByRole("application", { name: "Browser viewport" })).toBeInTheDocument()
  })
})
