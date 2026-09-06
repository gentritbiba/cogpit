import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { BrowserPanel } from "@/components/BrowserPanel"
import type { UseBrowserSessions } from "@/hooks/useBrowserSessions"
import type { UseBrowserSocket } from "@/hooks/useBrowserSocket"
import type { WorkspacePanelContext } from "@/plugin-api"
import type { BrowserClientMessage } from "../../../../shared/browser/protocol"
import type { BrowserSessionInfo } from "../../../../shared/browser/types"
import type { ParsedSession, ToolCall, Turn } from "../../../../shared/session/types"

vi.mock("@/hooks/useBrowserSessions", () => ({
  useBrowserSessions: (enabled: boolean) => sessionsDouble(enabled),
}))
vi.mock("@/hooks/useBrowserSocket", () => ({
  useBrowserSocket: (session: string | null) => socketDouble(session),
}))

// ── Hook doubles ─────────────────────────────────────────────────────────

const send = vi.fn<(message: BrowserClientMessage) => void>()
const installSkill = vi.fn(async () => ({ ok: true as const, path: "/home/me/skills/cogpit-browser" }))
const remove = vi.fn(async () => ({ ok: true as const }))
const stop = vi.fn(async () => ({ ok: true as const }))
const noop = vi.fn(async () => ({ ok: true as const }))
const refresh = vi.fn(async () => {})
const socketSessions: (string | null)[] = []

let installed = true
let browsers: BrowserSessionInfo[] = []
let socketState: "not-installed" | "stopped" | "connecting" | "live" = "live"
let socketError: string | null = null
let lastFrameAt: number | null = null

function sessionsDouble(enabled: boolean): UseBrowserSessions {
  return {
    status: enabled
      ? { installed, binaryPath: installed ? "/usr/local/bin/agent-browser" : null, sessions: browsers }
      : null,
    loading: false,
    error: null,
    refresh,
    create: noop,
    remove,
    launch: noop,
    stop,
    setNote: noop,
    installSkill,
  }
}

function socketDouble(session: string | null): UseBrowserSocket {
  socketSessions.push(session)
  return {
    status: session === null ? "idle" : "connected",
    state: session === null ? null : { type: "status", state: socketState, session },
    page: null,
    tabs: [],
    followed: null,
    frame: null,
    lastFrameAt,
    error: socketError,
    send,
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
  return <BrowserPanel context={context} active closePanel={vi.fn()} openPanel={vi.fn()} />
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
  socketError = null
  lastFrameAt = Date.now()
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => {}) },
  })
})

describe("BrowserPanel", () => {
  it("offers the install command and the agent skill when the CLI is missing", async () => {
    installed = false
    const { user } = setup()

    expect(screen.getByText("npm i -g agent-browser && agent-browser install")).toBeInTheDocument()
    expect(screen.queryByRole("application", { name: "Browser viewport" })).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Copy install command" }))
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /install the agent skill/i }))
    expect(installSkill).toHaveBeenCalledOnce()
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
