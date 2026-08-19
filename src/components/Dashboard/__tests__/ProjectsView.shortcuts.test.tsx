import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ProjectsView } from "../ProjectsView"

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const projects = [{
  dirName: "-workspace-cogpit",
  path: "/workspace/cogpit",
  shortName: "Cogpit",
  sessionCount: 7,
  lastModified: "2026-08-19T12:00:00.000Z",
}]

function renderView(overrides: Partial<React.ComponentProps<typeof ProjectsView>> = {}) {
  const props: React.ComponentProps<typeof ProjectsView> = {
    projects,
    activeSessions: [{
      dirName: "-workspace-cogpit",
      lastModified: new Date(Date.now() + 60_000).toISOString(),
    }],
    loading: false,
    refreshing: false,
    searchFilter: "",
    setSearchFilter: vi.fn(),
    fetchError: null,
    selectedProjectDirName: null,
    onSelectProject: vi.fn(),
    onRefresh: vi.fn(),
    ...overrides,
  }

  render(<ProjectsView {...props} />)
  return props
}

describe("ProjectsView", () => {
  it("shows a compact project list without the old shortcut manual", () => {
    renderView()

    expect(screen.getByRole("heading", { name: "Projects" })).toBeInTheDocument()
    expect(screen.getByText("cogpit")).toBeInTheDocument()
    expect(screen.getByText("1 active")).toBeInTheDocument()
    expect(screen.queryByText("Keyboard Shortcuts")).not.toBeInTheDocument()
    expect(screen.queryByText("Toggle session sidebar")).not.toBeInTheDocument()
  })

  it("opens projects and refreshes from the list toolbar", async () => {
    const user = userEvent.setup()
    const props = renderView()

    await user.click(screen.getByRole("button", { name: /cogpit/i }))
    await user.click(screen.getByRole("button", { name: "Refresh projects" }))

    expect(props.onSelectProject).toHaveBeenCalledWith("-workspace-cogpit")
    expect(props.onRefresh).toHaveBeenCalledOnce()
  })

  it("uses the standard empty state when a search has no matches", () => {
    renderView({ searchFilter: "missing" })

    expect(screen.getByText("No projects match your search")).toBeInTheDocument()
    expect(screen.getByText("Try a project name or path.")).toBeInTheDocument()
  })
})
