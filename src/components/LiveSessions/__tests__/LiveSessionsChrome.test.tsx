import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import type { ReactElement, ReactNode } from "react"
import { cloneElement, isValidElement } from "react"

import { LiveSessionsFeedback, SessionListOptions, SessionSearchField } from "../LiveSessionsChrome"

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render: renderProp, children }: { render?: ReactElement; children?: ReactNode }) => (
    isValidElement(renderProp)
      ? cloneElement(renderProp as ReactElement<{ children?: ReactNode }>, {}, children)
      : <>{children}</>
  ),
  TooltipContent: () => null,
}))

function renderSearch(overrides: Partial<Parameters<typeof SessionSearchField>[0]> = {}) {
  const props = {
    searchQuery: "",
    searchLoading: false,
    onSearchQueryChange: vi.fn(),
    onClose: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  }
  return { ...render(<SessionSearchField {...props} />), props }
}

describe("SessionSearchField", () => {
  it("is a focused search box for sessions and PRs", () => {
    renderSearch()

    const search = screen.getByRole("searchbox")
    expect(search).toHaveFocus()
    expect(search).toHaveAttribute("placeholder", "Search sessions or PRs")
    expect(search).toHaveAttribute("aria-busy", "false")
    expect(screen.queryByRole("heading", { name: "Sessions" })).not.toBeInTheDocument()
  })

  it("reports what is typed and whether a search is loading", () => {
    const { props, rerender } = renderSearch()

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "sidebar" } })
    expect(props.onSearchQueryChange).toHaveBeenCalledWith("sidebar")

    rerender(<SessionSearchField {...props} searchQuery="sidebar" searchLoading />)
    expect(screen.getByRole("searchbox")).toHaveAttribute("aria-busy", "true")
  })

  it("closes on Escape, which clears the query", () => {
    const { props } = renderSearch({ searchQuery: "sidebar" })

    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" })

    expect(props.onClose).toHaveBeenCalledOnce()
    expect(props.onDismiss).not.toHaveBeenCalled()
  })

  it("ignores other keys", () => {
    const { props } = renderSearch({ searchQuery: "sidebar" })

    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "a" })

    expect(props.onClose).not.toHaveBeenCalled()
    expect(props.onSearchQueryChange).not.toHaveBeenCalled()
  })

  it("closes from its close button, which clears the query", () => {
    const { props } = renderSearch({ searchQuery: "sidebar" })

    fireEvent.click(screen.getByRole("button", { name: "Close session search" }))

    expect(props.onClose).toHaveBeenCalledOnce()
  })

  it("stays while focus moves to its own close button, which a keyboard can then press", async () => {
    const user = userEvent.setup()
    const { props } = renderSearch()

    await user.tab()
    expect(screen.getByRole("button", { name: "Close session search" })).toHaveFocus()
    expect(props.onDismiss).not.toHaveBeenCalled()

    await user.keyboard("{Enter}")
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  it("goes away quietly when it loses focus empty, and stays open while it holds a query", () => {
    const empty = renderSearch()
    fireEvent.blur(screen.getByRole("searchbox"))
    expect(empty.props.onDismiss).toHaveBeenCalledOnce()
    expect(empty.props.onClose).not.toHaveBeenCalled()
    cleanup()

    const filled = renderSearch({ searchQuery: "  sidebar " })
    fireEvent.blur(screen.getByRole("searchbox"))
    expect(filled.props.onDismiss).not.toHaveBeenCalled()
  })
})

function renderOptions(overrides: Partial<Parameters<typeof SessionListOptions>[0]> = {}) {
  const props = {
    loading: false,
    showArchived: false,
    archivedCount: 0,
    groupCrews: true,
    onToggleGroupCrews: vi.fn(),
    onToggleShowArchived: vi.fn(),
    onRefresh: vi.fn(),
    onNewInFolder: vi.fn(),
    ...overrides,
  }
  return { ...render(<SessionListOptions {...props} />), props }
}

function openOptions() {
  fireEvent.click(screen.getByRole("button", { name: "Session list options" }))
}

describe("SessionListOptions", () => {
  it("keeps every option behind one button until it is opened", () => {
    renderOptions()

    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument()
    expect(screen.queryByRole("menuitemcheckbox")).not.toBeInTheDocument()

    openOptions()

    expect(screen.getByRole("menuitemcheckbox", { name: /Group spawned sessions/ })).toBeInTheDocument()
    expect(screen.getByRole("menuitemcheckbox", { name: /Show archived/ })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "New session in another folder…" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Refresh sessions" })).toBeInTheDocument()
  })

  it("toggles whether spawned sessions are grouped under the session that started them", () => {
    const { props, rerender } = renderOptions({ groupCrews: true })
    openOptions()

    const grouped = screen.getByRole("menuitemcheckbox", { name: /Group spawned sessions/ })
    expect(grouped).toHaveAttribute("aria-checked", "true")
    fireEvent.click(grouped)
    expect(props.onToggleGroupCrews).toHaveBeenCalledOnce()
    expect(screen.getByRole("menuitemcheckbox", { name: /Group spawned sessions/ })).toBeInTheDocument()

    rerender(<SessionListOptions {...props} groupCrews={false} />)
    expect(screen.getByRole("menuitemcheckbox", { name: /Group spawned sessions/ })).toHaveAttribute("aria-checked", "false")
  })

  it("toggles archived sessions, reflects the state and shows how many there are", () => {
    const { props, rerender } = renderOptions({ showArchived: true, archivedCount: 3 })
    openOptions()

    const archived = screen.getByRole("menuitemcheckbox", { name: /Show archived/ })
    expect(archived).toHaveAttribute("aria-checked", "true")
    expect(archived).toHaveTextContent("3")
    fireEvent.click(archived)
    expect(props.onToggleShowArchived).toHaveBeenCalledOnce()

    rerender(<SessionListOptions {...props} showArchived={false} archivedCount={0} />)
    const hidden = screen.getByRole("menuitemcheckbox", { name: /Show archived/ })
    expect(hidden).toHaveAttribute("aria-checked", "false")
    expect(hidden).not.toHaveTextContent("3")
  })

  it("starts a session in another folder and closes the menu", async () => {
    const { props } = renderOptions()
    openOptions()

    fireEvent.click(screen.getByRole("menuitem", { name: "New session in another folder…" }))

    expect(props.onNewInFolder).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByRole("menuitem")).not.toBeInTheDocument())
  })

  it("refreshes the list and closes the menu", async () => {
    const { props } = renderOptions()
    openOptions()

    fireEvent.click(screen.getByRole("menuitem", { name: "Refresh sessions" }))

    expect(props.onRefresh).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByRole("menuitem")).not.toBeInTheDocument())
  })

  it("leaves out the folder item where sessions cannot be started", () => {
    renderOptions({ onNewInFolder: undefined })
    openOptions()

    expect(screen.queryByRole("menuitem", { name: /another folder/ })).not.toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Refresh sessions" })).toBeInTheDocument()
  })

  it("spins its button while the list loads", () => {
    const { container } = renderOptions({ loading: true })

    expect(container.querySelector("button .animate-spin")).not.toBeNull()
  })
})

describe("LiveSessionsFeedback", () => {
  const base = {
    fetchError: null,
    showEmpty: true,
    searching: false,
    loading: false,
    sessionCount: 0,
    onRetry: vi.fn(),
  }

  it("explains an empty list when every session is archived and offers to show them", () => {
    const onShowArchived = vi.fn()
    render(<LiveSessionsFeedback {...base} hiddenArchivedCount={4} onShowArchived={onShowArchived} />)

    expect(screen.getByText("Everything is archived")).toBeInTheDocument()
    expect(screen.getByText("4 archived sessions are hidden.")).toBeInTheDocument()
    expect(screen.queryByText("No sessions yet")).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Show archived" }))
    expect(onShowArchived).toHaveBeenCalledOnce()
  })

  it("keeps the plain empty state when nothing is archived", () => {
    render(<LiveSessionsFeedback {...base} hiddenArchivedCount={0} onShowArchived={vi.fn()} />)

    expect(screen.getByText("No sessions yet")).toBeInTheDocument()
    expect(screen.queryByText("Everything is archived")).not.toBeInTheDocument()
  })

  it("offers a New session button in the plain empty state", () => {
    const onNewSession = vi.fn()
    render(<LiveSessionsFeedback {...base} hiddenArchivedCount={0} onShowArchived={vi.fn()} onNewSession={onNewSession} />)

    expect(screen.getByText("Pick a project or folder to start your first session.")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "New session" }))
    expect(onNewSession).toHaveBeenCalledOnce()
  })

  it("points to the agent CLIs when sessions cannot be started here", () => {
    render(<LiveSessionsFeedback {...base} hiddenArchivedCount={0} onShowArchived={vi.fn()} />)

    expect(screen.getByText("Start Claude Code, Codex, or Copilot to see recent work here.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "New session" })).not.toBeInTheDocument()
  })

  it("offers no New session button for an empty search", () => {
    render(<LiveSessionsFeedback {...base} searching hiddenArchivedCount={0} onShowArchived={vi.fn()} onNewSession={vi.fn()} />)

    expect(screen.getByText("No matching sessions")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "New session" })).not.toBeInTheDocument()
  })

  it("does not blame archiving for an empty search", () => {
    render(<LiveSessionsFeedback {...base} searching hiddenArchivedCount={4} onShowArchived={vi.fn()} />)

    expect(screen.getByText("No matching sessions")).toBeInTheDocument()
  })
})

describe("LiveSessionsFeedback when focused on a project", () => {
  const base = {
    fetchError: null,
    showEmpty: true,
    searching: false,
    loading: false,
    sessionCount: 0,
    onRetry: vi.fn(),
    onShowArchived: vi.fn(),
  }

  it("names the project and offers the way back to every project", () => {
    const onShowAllProjects = vi.fn()
    render(
      <LiveSessionsFeedback {...base} hiddenArchivedCount={0} focusedProject="App" onShowAllProjects={onShowAllProjects} />,
    )

    expect(screen.getByText("No sessions in App")).toBeInTheDocument()
    expect(screen.queryByText("No sessions yet")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "All projects" }))
    expect(onShowAllProjects).toHaveBeenCalledOnce()
  })

  it("mentions hidden archived sessions instead of claiming everything is archived", () => {
    render(<LiveSessionsFeedback {...base} hiddenArchivedCount={4} focusedProject="App" onShowAllProjects={vi.fn()} />)

    expect(screen.getByText("No sessions in App")).toBeInTheDocument()
    expect(screen.queryByText("Everything is archived")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Show archived" })).toBeInTheDocument()
  })

  it("scopes an empty search to the project", () => {
    render(<LiveSessionsFeedback {...base} searching hiddenArchivedCount={0} focusedProject="App" onShowAllProjects={vi.fn()} onNewSessionHere={vi.fn()} />)

    expect(screen.getByText("No matching sessions in App")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "New session" })).not.toBeInTheDocument()
  })

  it("starts a session in the project it names", () => {
    const onNewSessionHere = vi.fn()
    render(<LiveSessionsFeedback {...base} hiddenArchivedCount={0} focusedProject="App" onShowAllProjects={vi.fn()} onNewSessionHere={onNewSessionHere} />)

    fireEvent.click(screen.getByRole("button", { name: "New session" }))
    expect(onNewSessionHere).toHaveBeenCalledOnce()
  })
})

describe("LiveSessionsFeedback left empty by the session list filter", () => {
  const base = {
    fetchError: null,
    showEmpty: true,
    searching: false,
    loading: false,
    sessionCount: 0,
    hiddenArchivedCount: 0,
    onRetry: vi.fn(),
    onShowArchived: vi.fn(),
  }
  const filterEmpty = <p>Nothing under this filter</p>

  it("shows what the filter stands in with", () => {
    render(<LiveSessionsFeedback {...base} filterEmpty={filterEmpty} />)

    expect(screen.getByText("Nothing under this filter")).toBeInTheDocument()
    expect(screen.queryByText("No sessions yet")).not.toBeInTheDocument()
  })

  it("keeps the plain empty state for an unfiltered list and for a search", () => {
    const { rerender } = render(<LiveSessionsFeedback {...base} filterEmpty={null} />)
    expect(screen.getByText("No sessions yet")).toBeInTheDocument()

    rerender(<LiveSessionsFeedback {...base} searching filterEmpty={filterEmpty} />)
    expect(screen.getByText("No matching sessions")).toBeInTheDocument()
    expect(screen.queryByText("Nothing under this filter")).not.toBeInTheDocument()
  })

  it("lets a list emptied by the archive filter explain itself first", () => {
    render(<LiveSessionsFeedback {...base} hiddenArchivedCount={2} filterEmpty={filterEmpty} />)

    expect(screen.getByText("Everything is archived")).toBeInTheDocument()
    expect(screen.queryByText("Nothing under this filter")).not.toBeInTheDocument()
  })
})
