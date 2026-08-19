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
    expect(screen.getByText("Try a session title, model, or ID.")).toBeInTheDocument()
  })
})
