import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { ProcessPanel } from "../ProcessPanel"
import { startAgentSignIn } from "@/lib/agents/signIn"
import { codeModeTerminalStatus, setCodeModeEnabled, showCodeModeTerminal, startCodeModeSession } from "@/lib/agents/codeMode"

const mocks = vi.hoisted(() => ({
  ptySessions: [] as Array<{ id: string; name: string; status: "running" | "exited"; cwd: string; metadata?: { type: "terminal"; sessionId?: string } }>,
  ptyStatus: "connected",
  spawnTerminal: vi.fn(() => "pty_1"),
  killSession: vi.fn(),
  runScript: vi.fn(),
  stopScript: vi.fn(),
}))

vi.mock("@/contexts/PtyContext", () => ({
  usePty: () => ({
    sessions: mocks.ptySessions,
    status: mocks.ptyStatus,
    listed: true,
    killSession: mocks.killSession,
    spawnTerminal: mocks.spawnTerminal,
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
  it("renders nothing on desktop while collapsed with no processes", () => {
    const { container } = render(
      <ProcessPanel {...defaultProps} collapsed projectDir="/project" />,
    )

    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole("button", { name: "Expand terminal panel" })).not.toBeInTheDocument()
  })

  it("keeps the terminal controls visible on mobile when there are no processes", () => {
    const onToggleCollapse = vi.fn()

    render(
      <ProcessPanel
        {...defaultProps}
        collapsed
        mobile
        projectDir="/project"
        onToggleCollapse={onToggleCollapse}
        onRequestTerminal={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Expand terminal panel" }))

    expect(onToggleCollapse).toHaveBeenCalledOnce()
    expect(screen.getByRole("button", { name: "New terminal" })).toBeEnabled()
    expect(screen.queryByRole("region", { name: "Scripts" })).not.toBeInTheDocument()
  })

  it("shows the empty panel on desktop once it is expanded with no processes", () => {
    render(
      <ProcessPanel {...defaultProps} collapsed={false} projectDir="/project" onRequestTerminal={vi.fn()} />,
    )

    expect(screen.getByRole("button", { name: "Collapse terminal panel" })).toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: "New terminal" })[0]).toBeEnabled()
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
    // Nothing is listed beside it, so it points at nothing there.
    expect(screen.getByText("Open a project to start a terminal.")).toBeInTheDocument()
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

  it("streams a task's output by its path alone, leaving its session to the server", () => {
    const opened: string[] = []
    vi.stubGlobal("EventSource", class extends EventTarget {
      onopen: (() => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: (() => void) | null = null
      constructor(url: string) {
        super()
        opened.push(url)
      }
      close() {}
    })
    const outputPath = "/tmp/claude-501/-work/0f8fad5b-d9cb-469f-a165-70867728950e/tasks/b1.output"
    const processes = new Map([
      ["task-1", { id: "task-1", name: "Dev server", type: "task" as const, status: "running" as const, outputPath }],
    ])

    try {
      render(<ProcessPanel {...defaultProps} processes={processes} activeProcessId="task-1" collapsed={false} />)
      const url = new URL(opened[0], "http://cogpit.test")
      expect(url.pathname).toBe("/api/task-output")
      expect(url.searchParams.get("path")).toBe(outputPath)
      expect(url.searchParams.has("sessionId")).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("runs an agent's sign-in in a new terminal tab when asked", () => {
    const onProcessStarted = vi.fn()
    const { unmount } = render(<ProcessPanel {...defaultProps} collapsed projectDir="/project" onProcessStarted={onProcessStarted} />)

    expect(startAgentSignIn({ kind: "codex", instanceId: "work" })).toBe(true)
    // The server builds the command from the agent and account; the panel only names them.
    expect(mocks.spawnTerminal).toHaveBeenCalledWith({ name: "Sign in to Codex", cwd: "/project", signIn: { agent: "codex", instanceId: "work" } })
    expect(onProcessStarted).toHaveBeenCalledWith({ id: "pty_1", name: "Sign in to Codex", type: "terminal", status: "running", source: "/project" })

    unmount()
    expect(startAgentSignIn({ kind: "codex", instanceId: null })).toBe(false)
  })

  it("runs a Code Mode session in a new terminal tab and finds it again", () => {
    setCodeModeEnabled("local", false)
    const onProcessStarted = vi.fn()
    // A fresh map stands in for the terminal list update that re-renders the memoised panel.
    const panel = () => <ProcessPanel {...defaultProps} processes={new Map()} collapsed projectDir="/elsewhere" onProcessStarted={onProcessStarted} />
    const { rerender, unmount } = render(panel())

    expect(startCodeModeSession({ kind: "claude", sessionId: "s-1", resume: false, cwd: "/project", prompt: "hi" })).toBe(true)
    // The server builds the command from what the panel names.
    expect(mocks.spawnTerminal).toHaveBeenCalledWith({
      name: "Claude Code · Code Mode",
      cwd: "/project",
      codeMode: { agent: "claude", sessionId: "s-1", resume: false, prompt: "hi" },
    })
    expect(onProcessStarted).toHaveBeenCalledWith({ id: "pty_1", name: "Claude Code · Code Mode", type: "terminal", status: "running", source: "/project", sessionId: "s-1" })
    expect(codeModeTerminalStatus("s-1")).toBeNull()

    mocks.ptySessions = [{ id: "pty_1", name: "Claude Code · Code Mode", status: "running", cwd: "/project", metadata: { type: "terminal", sessionId: "s-1" } }]
    rerender(panel())
    expect(codeModeTerminalStatus("s-1")).toBe("running")
    onProcessStarted.mockClear()
    expect(showCodeModeTerminal("s-1")).toBe(true)
    expect(onProcessStarted).toHaveBeenCalledWith(expect.objectContaining({ id: "pty_1", sessionId: "s-1" }))

    mocks.ptySessions = [{ ...mocks.ptySessions[0]!, status: "exited" }]
    rerender(panel())
    expect(codeModeTerminalStatus("s-1")).toBe("exited")
    expect(showCodeModeTerminal("s-1")).toBe(false)

    mocks.ptySessions = []
    unmount()
    expect(startCodeModeSession({ kind: "claude", sessionId: "s-2", resume: true, cwd: "/project" })).toBe(false)
  })

  it("offers no sign-in runner on a phone", () => {
    render(<ProcessPanel {...defaultProps} collapsed mobile projectDir="/project" onProcessStarted={vi.fn()} />)
    expect(startAgentSignIn({ kind: "codex", instanceId: null })).toBe(false)
  })
})
