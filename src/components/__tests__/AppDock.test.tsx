import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AppDock } from "@/components/AppDock"
import type { AccountControlProps } from "@/edition/contract"
import { __installEditionUiForTest, __resetEditionUiForTest } from "@/edition/registry"
import type { AgentKind } from "@/lib/agents"
import type { ActiveSessionInfo } from "@/components/LiveSessions/types"

const mocks = vi.hoisted(() => ({
  sessionSource: null as { dirName: string; fileName: string; agentKind?: AgentKind } | null,
  inventorySessions: [] as ActiveSessionInfo[],
}))

vi.mock("@/contexts/AppContext", () => ({
  useAppContext: () => ({ config: { defaultAgentKind: "claude", networkUrl: null } }),
}))
vi.mock("@/contexts/SessionContext", () => ({
  useSessionControls: () => ({ sessionSource: mocks.sessionSource }),
}))
vi.mock("@/contexts/SessionInventoryContext", () => ({
  useSessionInventoryOptional: () => ({ sessions: mocks.inventorySessions }),
}))
vi.mock("@/hooks/useCapability", () => ({ useCapability: () => true }))
vi.mock("@/components/LeakIndicator", () => ({
  LeakIndicator: ({ onReview }: { onReview: () => void }) => <button onClick={onReview}>Leak monitor</button>,
}))
vi.mock("@/components/TokenUsageWidget", () => ({
  TokenUsageIndicator: ({ agentKind }: { agentKind: string }) => <span>Usage for {agentKind}</span>,
}))
vi.mock("@/components/DeviceSwitcher", () => ({ DeviceSwitcher: () => null }))
vi.mock("@/components/UpdatesMenu", () => ({ UpdatesMenu: () => null }))
vi.mock("@/components/PowerMonitor", () => ({
  PowerMonitor: ({ open }: { open: boolean }) => (open ? <div data-testid="power-monitor" /> : null),
}))
vi.mock("@/components/UsageCostDialog", () => ({ UsageCostDialog: () => null }))

const PROPS = {
  killing: false,
  onKillAll: vi.fn(),
  onOpenSettings: vi.fn(),
  onOpenCommandPalette: vi.fn(),
  onOpenKeyboardShortcuts: vi.fn(),
  onOpenPlugins: vi.fn(),
  onOpenAgentFiles: vi.fn(),
  onToggleTerminal: vi.fn(),
  terminalShortcut: "Ctrl+`",
  onLogout: vi.fn(),
  onOpenMainView: vi.fn(),
}

function scannedSession(): ActiveSessionInfo {
  return {
    dirName: "d",
    projectShortName: "P",
    fileName: "f.jsonl",
    sessionId: "s1",
    lastModified: "2026-08-14T10:00:00.000Z",
    size: 1,
  }
}

describe("AppDock", () => {
  beforeEach(() => {
    mocks.sessionSource = null
    mocks.inventorySessions = []
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    __resetEditionUiForTest()
  })

  it("keeps the machine-wide leak badge away until the user has a session", () => {
    const { unmount } = render(<AppDock {...PROPS} />)
    expect(screen.queryByText("Leak monitor")).not.toBeInTheDocument()
    unmount()

    mocks.inventorySessions = [scannedSession()]
    render(<AppDock {...PROPS} />)
    expect(screen.getByText("Leak monitor")).toBeInTheDocument()
  })

  it("opens the server monitor from the leak badge", async () => {
    mocks.inventorySessions = [scannedSession()]
    render(<AppDock {...PROPS} />)

    await userEvent.click(screen.getByRole("button", { name: "Leak monitor" }))

    expect(screen.getByTestId("power-monitor")).toBeInTheDocument()
  })

  it("reads usage for the open session's agent, else the default agent", () => {
    const { unmount } = render(<AppDock {...PROPS} />)
    expect(screen.getByText("Usage for claude")).toBeInTheDocument()
    unmount()

    mocks.sessionSource = { dirName: "codex__L3RtcC9wcm9qZWN0", fileName: "s.jsonl" }
    render(<AppDock {...PROPS} />)
    expect(screen.getByText("Usage for codex")).toBeInTheDocument()
  })

  it("offers the terminal toggle only with a handler", async () => {
    const { unmount } = render(<AppDock {...PROPS} />)
    await userEvent.click(screen.getByRole("button", { name: "Terminal" }))
    expect(PROPS.onToggleTerminal).toHaveBeenCalledOnce()
    unmount()

    render(<AppDock {...PROPS} onToggleTerminal={undefined} />)
    expect(screen.queryByRole("button", { name: "Terminal" })).not.toBeInTheDocument()
  })

  it("always carries the app menu", () => {
    render(<AppDock {...PROPS} />)
    expect(screen.getByRole("button", { name: "Settings and more" })).toBeInTheDocument()
  })

  it("carries the edition's account control, wired to sign-out and the edition's main views", async () => {
    const { unmount } = render(<AppDock {...PROPS} />)
    expect(screen.queryByRole("button", { name: "Account" })).not.toBeInTheDocument()
    unmount()

    __installEditionUiForTest({
      AccountControl: ({ onLogout, onOpenMainView }: AccountControlProps) => (
        <>
          <button onClick={onLogout}>Account</button>
          <button onClick={() => onOpenMainView("reports")}>Reports</button>
        </>
      ),
    })
    render(<AppDock {...PROPS} />)

    await userEvent.click(screen.getByRole("button", { name: "Account" }))
    await userEvent.click(screen.getByRole("button", { name: "Reports" }))
    expect(PROPS.onLogout).toHaveBeenCalledOnce()
    expect(PROPS.onOpenMainView).toHaveBeenCalledWith("reports")
  })
})
