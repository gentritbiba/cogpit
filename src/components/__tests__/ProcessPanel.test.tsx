import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { ProcessPanel } from "../ProcessPanel"

const mocks = vi.hoisted(() => ({
  killSession: vi.fn(),
  runScript: vi.fn(),
  stopScript: vi.fn(),
}))

vi.mock("@/contexts/PtyContext", () => ({
  usePty: () => ({
    sessions: [],
    killSession: mocks.killSession,
  }),
}))

vi.mock("@/hooks/useScriptDiscovery", () => ({
  useScriptDiscovery: () => ({
    scripts: [
      {
        name: "test",
        command: "bun test",
        dir: "/project",
        dirLabel: "root/",
        isCommon: true,
      },
      {
        name: "lint",
        command: "bun lint",
        dir: "/project",
        dirLabel: "root/",
        isCommon: false,
      },
    ],
    loading: false,
  }),
}))

vi.mock("@/hooks/useScriptRunner", () => ({
  useScriptRunner: () => ({
    runningProcesses: new Map(),
    runScript: mocks.runScript,
    stopScript: mocks.stopScript,
  }),
}))

vi.mock("@/components/TerminalOutput", () => ({
  TerminalOutput: () => <div>Terminal output</div>,
}))

const defaultProps = {
  processes: new Map(),
  activeProcessId: null,
  onSetActive: vi.fn(),
  onRemove: vi.fn(),
  onToggleCollapse: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(cleanup)

describe("ProcessPanel", () => {
  it("keeps the terminal controls visible when there are no processes", () => {
    const onToggleCollapse = vi.fn()
    const onRequestTerminal = vi.fn()

    render(
      <ProcessPanel
        {...defaultProps}
        collapsed
        projectDir="/project"
        onToggleCollapse={onToggleCollapse}
        onRequestTerminal={onRequestTerminal}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Expand terminal panel" }))

    expect(onToggleCollapse).toHaveBeenCalledOnce()
    expect(screen.getByRole("button", { name: "New terminal" })).toBeEnabled()
    expect(screen.queryByRole("region", { name: "Scripts" })).not.toBeInTheDocument()
  })

  it("shows project scripts on the left side of the expanded terminal panel", () => {
    const onRequestTerminal = vi.fn()

    render(
      <ProcessPanel
        {...defaultProps}
        collapsed={false}
        projectDir="/project"
        onRequestTerminal={onRequestTerminal}
      />,
    )

    expect(screen.getByRole("region", { name: "Scripts" })).toBeInTheDocument()
    expect(screen.getByText("No terminal open")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "test" }))
    expect(mocks.runScript).toHaveBeenCalledWith("test", "/project", "root/")

    fireEvent.click(screen.getByRole("button", { name: "Search scripts" }))
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter scripts" }), {
      target: { value: "missing" },
    })
    expect(screen.getByText("No matching scripts")).toBeInTheDocument()

    fireEvent.click(screen.getAllByRole("button", { name: "New terminal" })[1])
    expect(onRequestTerminal).toHaveBeenCalledOnce()
  })

  it("disables new terminals and hides scripts without a project", () => {
    render(
      <ProcessPanel
        {...defaultProps}
        collapsed={false}
        projectDir={null}
        onRequestTerminal={vi.fn()}
      />,
    )

    expect(screen.getByRole("button", { name: "New terminal" })).toBeDisabled()
    expect(screen.queryByRole("region", { name: "Scripts" })).not.toBeInTheDocument()
    expect(screen.getByText("No terminal open")).toBeInTheDocument()
  })

  it("keeps process selection and close actions as separate controls", () => {
    const onSetActive = vi.fn()
    const onRemove = vi.fn()
    const processes = new Map([
      [
        "terminal-1",
        {
          id: "terminal-1",
          name: "Shell",
          type: "terminal" as const,
          status: "running" as const,
        },
      ],
    ])

    render(
      <ProcessPanel
        {...defaultProps}
        processes={processes}
        activeProcessId="terminal-1"
        collapsed
        onSetActive={onSetActive}
        onRemove={onRemove}
      />,
    )

    const tab = screen.getByRole("tab", { name: "Shell" })
    const closeButton = screen.getByRole("button", { name: "Close Shell" })

    expect(tab).toHaveAttribute("aria-selected", "true")
    expect(tab.contains(closeButton)).toBe(false)

    fireEvent.click(tab)
    fireEvent.click(closeButton)

    expect(onSetActive).toHaveBeenCalledWith("terminal-1")
    expect(mocks.killSession).toHaveBeenCalledWith("terminal-1")
    expect(onRemove).toHaveBeenCalledWith("terminal-1")
  })

  it("links the controlled process tabs to their panels", () => {
    const onSetActive = vi.fn()
    const processes = new Map([
      [
        "terminal-1",
        {
          id: "terminal-1",
          name: "Shell",
          type: "terminal" as const,
          status: "running" as const,
        },
      ],
      [
        "terminal-2",
        {
          id: "terminal-2",
          name: "Server",
          type: "terminal" as const,
          status: "running" as const,
        },
      ],
    ])

    render(
      <ProcessPanel
        {...defaultProps}
        processes={processes}
        activeProcessId="terminal-1"
        collapsed={false}
        onSetActive={onSetActive}
      />,
    )

    const tabList = screen.getByRole("tablist", { name: "Open processes" })
    const shellTab = screen.getByRole("tab", { name: "Shell" })
    const serverTab = screen.getByRole("tab", { name: "Server" })
    const panel = screen.getByRole("tabpanel")

    expect(tabList).toContainElement(shellTab)
    expect(shellTab).toHaveAttribute("aria-selected", "true")
    expect(serverTab).toHaveAttribute("aria-selected", "false")
    expect(shellTab).toHaveAttribute("aria-controls", panel.id)
    expect(panel).toHaveAttribute("aria-labelledby", shellTab.id)

    fireEvent.click(serverTab)
    expect(onSetActive).toHaveBeenCalledWith("terminal-2")
  })
})
