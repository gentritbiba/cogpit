import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { SessionsView } from "../SessionsView"

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const project = {
  dirName: "-workspace-cogpit",
  path: "/workspace/cogpit",
  shortName: "Cogpit",
  sessionCount: 1,
  lastModified: "2026-08-19T12:00:00.000Z",
}

const session = {
  fileName: "session-1.jsonl",
  sessionId: "session-1",
  slug: "first-session",
  size: 4_096,
  lastModified: new Date(Date.now() + 60_000).toISOString(),
  firstUserMessage: "Clean up the dashboard",
  turnCount: 5,
  gitBranch: "main",
  model: "claude-opus-4-1",
}

function renderView(overrides: Partial<React.ComponentProps<typeof SessionsView>> = {}) {
  const props: React.ComponentProps<typeof SessionsView> = {
    selectedProject: project,
    sessions: [session],
    sessionsTotal: 1,
    sessionsLoading: false,
    searchLoading: false,
    searchFilter: "",
    setSearchFilter: vi.fn(),
    filteredSessions: [session],
    fetchError: null,
    onSelectSession: vi.fn(),
    onNewSession: vi.fn(),
    creatingSession: false,
    onBack: vi.fn(),
    onRetryFetch: vi.fn(),
    loadMoreSessions: vi.fn(),
    ...overrides,
  }

  render(<SessionsView {...props} />)
  return props
}

const richSession = {
  ...session,
  sessionId: "session-2",
  fileName: "session-2.jsonl",
  aiTitle: "Rewrite the dashboard rows",
  lastUserMessage: "now make the rows denser",
  lastActivityAt: new Date().toISOString(),
  timestamp: new Date(Date.now() - 90 * 60_000).toISOString(),
  agentStatus: "tool_use" as const,
  agentToolName: "Bash",
  pullRequests: [
    {
      number: 482,
      url: "https://github.com/acme/cogpit/pull/482",
      repo: "acme/cogpit",
      title: "Rewrite the dashboard rows",
      isDraft: false,
      toolCallId: "toolu_pr_482",
      timestamp: new Date(Date.now() - 30 * 60_000).toISOString(),
    },
  ],
}

describe("SessionsView", () => {
  it("opens a session from the compact project list", async () => {
    const user = userEvent.setup()
    const props = renderView()

    expect(screen.getByText("Clean up the dashboard")).toBeInTheDocument()
    expect(screen.getByText("Active")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /first-session/ }))

    expect(props.onSelectSession).toHaveBeenCalledWith(
      "-workspace-cogpit",
      "session-1.jsonl",
    )
  })

  it("starts a session in the current project", async () => {
    const user = userEvent.setup()
    const props = renderView()

    await user.click(screen.getByRole("button", { name: "New Session" }))

    expect(props.onNewSession).toHaveBeenCalledWith(
      "-workspace-cogpit",
      "/workspace/cogpit",
    )
  })

  it("shows the standard empty state for a search with no matches", () => {
    renderView({ searchFilter: "missing", filteredSessions: [] })

    expect(screen.getByText("No sessions match your search")).toBeInTheDocument()
    expect(screen.getByText("Try #157, honest-cms #157, or paste a PR URL.")).toBeInTheDocument()
  })

  it("surfaces what a session actually did", () => {
    renderView({ sessions: [richSession], filteredSessions: [richSession] })

    // The generated title wins over the slug, and the latest prompt is the preview.
    expect(screen.getByText("Rewrite the dashboard rows")).toBeInTheDocument()
    expect(screen.getByText("now make the rows denser")).toBeInTheDocument()

    expect(screen.getByText("Using Bash")).toBeInTheDocument()
    expect(screen.getByText("opus")).toBeInTheDocument()
    expect(screen.getByText("5 turns")).toBeInTheDocument()
    expect(screen.getByText("main")).toBeInTheDocument()
    expect(screen.getByText("1h 30m")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Pull request #482" })).toBeInTheDocument()
  })

  it("flags a session that ended badly instead of claiming it is live", () => {
    const stopped = {
      ...richSession,
      lastActivityAt: new Date(Date.now() - 86_400_000).toISOString(),
      lastModified: new Date(Date.now() - 86_400_000).toISOString(),
      agentStatus: "completed" as const,
      agentToolName: undefined,
      agentTerminalReason: "max_turns",
    }
    renderView({ sessions: [stopped], filteredSessions: [stopped] })

    expect(screen.getByText("Stopped — turn limit reached")).toBeInTheDocument()
    expect(screen.queryByText("Active")).not.toBeInTheDocument()
  })
})
