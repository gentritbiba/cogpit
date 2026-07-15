import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { CommandPalette } from "@/components/CommandPalette"

function createProps() {
  return {
    open: true,
    onOpenChange: vi.fn(),
    onGoHome: vi.fn(),
    onNewSession: vi.fn(),
    onToggleSidebar: vi.fn(),
    onToggleStats: vi.fn(),
    onToggleFileChanges: vi.fn(),
    onToggleWorktrees: vi.fn(),
    onOpenConfig: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenTheme: vi.fn(),
    onOpenTerminal: vi.fn(),
    onFocusComposer: vi.fn(),
    onExpandAll: vi.fn(),
    onCollapseAll: vi.fn(),
    canFocusComposer: true,
    canOpenTerminal: true,
    hasSession: true,
    hasFileChanges: true,
    supportsWorktrees: true,
    showSidebar: true,
    showStats: false,
    showFileChanges: true,
    showWorktrees: false,
    showConfig: false,
  }
}

describe("CommandPalette", () => {
  it("runs an action and closes the palette", async () => {
    const user = userEvent.setup()
    const props = createProps()
    render(<CommandPalette {...props} />)

    await user.click(screen.getByText("Go to dashboard"))

    expect(props.onOpenChange).toHaveBeenCalledWith(false)
    expect(props.onGoHome).toHaveBeenCalledOnce()
  })

  it("uses the latest concise user message for recent Codex sessions", () => {
    render(
      <CommandPalette
        {...createProps()}
        recentSessions={[{
        dirName: "codex__project",
        fileName: "rollout.jsonl",
        sessionId: "session-1",
        projectShortName: "Project",
        firstUserMessage: "<recommended_plugins>" + " context".repeat(100),
        lastUserMessage: "continue adapting useful features",
        }]}
      />,
    )

    expect(screen.getByRole("option", { name: /continue adapting useful features/ })).toBeInTheDocument()
  })

  it("runs the highlighted action from the keyboard", async () => {
    const user = userEvent.setup()
    const props = createProps()
    render(<CommandPalette {...props} />)

    await user.type(screen.getByRole("combobox", { name: "Search commands" }), "dashboard")
    await user.keyboard("{Enter}")

    expect(props.onOpenChange).toHaveBeenCalledWith(false)
    expect(props.onGoHome).toHaveBeenCalledOnce()
  })

  it("exposes the project file workspace when a project is active", async () => {
    const user = userEvent.setup()
    const props = { ...createProps(), onToggleProjectFiles: vi.fn(), showProjectFiles: false }
    render(<CommandPalette {...props} />)

    await user.click(screen.getByText("Open project files"))

    expect(props.onToggleProjectFiles).toHaveBeenCalledOnce()
  })

  it("hides actions that are invalid without an active project or session", () => {
    const props = createProps()
    render(
      <CommandPalette
        {...props}
        canFocusComposer={false}
        canOpenTerminal={false}
        hasFileChanges={false}
        hasSession={false}
        supportsWorktrees={false}
      />,
    )

    expect(screen.queryByText("Focus message composer")).not.toBeInTheDocument()
    expect(screen.queryByText("Open project terminal")).not.toBeInTheDocument()
    expect(screen.queryByText("Show session analytics")).not.toBeInTheDocument()
    expect(screen.queryByText("Hide file changes")).not.toBeInTheDocument()
    expect(screen.queryByText("Show worktrees")).not.toBeInTheDocument()
  })
})
