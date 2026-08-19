import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { CommandPalette } from "@/components/CommandPalette"
import { createCommandPaletteProps as createProps } from "./commandPaletteProps"

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

  it("hides raw configuration navigation when no authorized callback is provided", () => {
    render(<CommandPalette {...createProps()} onOpenConfig={undefined} />)

    expect(screen.queryByText("Open agent configuration")).not.toBeInTheDocument()
  })

  it("indexes Mission Control and reflects whether it is already open", async () => {
    const user = userEvent.setup()
    const props = createProps()
    const { rerender } = render(<CommandPalette {...props} />)

    await user.click(screen.getByText("Open Mission Control"))
    expect(props.onToggleMissionControl).toHaveBeenCalledOnce()

    rerender(<CommandPalette {...props} showMission />)
    expect(screen.getByText("Exit Mission Control")).toBeInTheDocument()
  })

  it("indexes the session actions that are otherwise only reachable from chrome", async () => {
    const user = userEvent.setup()
    const props = {
      ...createProps(),
      onDuplicateSession: vi.fn(),
      onCopyResumeCommand: vi.fn(),
      onFindInConversation: vi.fn(),
      onKillAll: vi.fn(),
    }
    render(<CommandPalette {...props} />)

    await user.click(screen.getByText("Duplicate this session"))
    await user.click(screen.getByText("Copy resume command"))
    await user.click(screen.getByText("Find in conversation"))
    await user.click(screen.getByText("Kill all agent processes"))

    expect(props.onDuplicateSession).toHaveBeenCalledOnce()
    expect(props.onCopyResumeCommand).toHaveBeenCalledOnce()
    expect(props.onFindInConversation).toHaveBeenCalledOnce()
    expect(props.onKillAll).toHaveBeenCalledOnce()
  })

  it("omits session-scoped and privileged actions when their callbacks are absent", () => {
    render(<CommandPalette {...createProps()} />)

    expect(screen.queryByText("Duplicate this session")).not.toBeInTheDocument()
    expect(screen.queryByText("Copy resume command")).not.toBeInTheDocument()
    expect(screen.queryByText("Find in conversation")).not.toBeInTheDocument()
    expect(screen.queryByText("Kill all agent processes")).not.toBeInTheDocument()
  })

  it("always offers device management so the first device can be added without the header switcher", async () => {
    const user = userEvent.setup()
    const onOpenDevices = vi.fn()
    render(<CommandPalette {...createProps()} onOpenDevices={onOpenDevices} devices={[]} />)

    await user.click(screen.getByText("Add device…"))
    await user.click(screen.getByText("Manage devices…"))

    expect(onOpenDevices).toHaveBeenNthCalledWith(1, "add")
    expect(onOpenDevices).toHaveBeenNthCalledWith(2, "manage")
  })

  it("lists devices with their switch shortcuts once a remote device exists", async () => {
    const user = userEvent.setup()
    const onSwitchDevice = vi.fn()
    render(
      <CommandPalette
        {...createProps()}
        onSwitchDevice={onSwitchDevice}
        devices={[
          { id: "local", name: "This machine", isLocal: true, isActive: true },
          { id: "dev_1", name: "Studio", isLocal: false, isActive: false },
        ]}
      />,
    )

    expect(screen.getByText("This machine (current)")).toBeInTheDocument()
    await user.click(screen.getByText("Switch to Studio"))

    expect(onSwitchDevice).toHaveBeenCalledWith("dev_1")
  })

  it("hides the device group for a single-machine install", () => {
    render(
      <CommandPalette
        {...createProps()}
        onSwitchDevice={vi.fn()}
        devices={[{ id: "local", name: "This machine", isLocal: true, isActive: true }]}
      />,
    )

    expect(screen.queryByText("This machine (current)")).not.toBeInTheDocument()
  })
})
