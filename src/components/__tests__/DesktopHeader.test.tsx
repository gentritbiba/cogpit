import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DesktopHeader } from "@/components/DesktopHeader"
import { getResumeCommand } from "@/lib/sessionSource"

const mocks = vi.hoisted(() => ({
  config: { networkUrl: null as string | null, defaultAgentKind: "claude" as const },
  session: null as object | null,
  sessionSource: null as object | null,
  isLive: false,
  copy: vi.fn(),
}))

vi.mock("@/contexts/AppContext", () => ({
  useAppContext: () => ({ config: mocks.config }),
}))
vi.mock("@/contexts/SessionContext", () => ({
  useSessionContext: () => ({
    session: mocks.session,
    sessionSource: mocks.sessionSource,
    isLive: mocks.isLive,
  }),
}))
vi.mock("@/hooks/useCopyWithFeedback", () => ({
  useCopyWithFeedback: () => [false, mocks.copy],
}))
vi.mock("@/components/TokenUsageWidget", () => ({ TokenUsageIndicator: () => null }))
vi.mock("@/components/LeakIndicator", () => ({ LeakIndicator: () => null }))
vi.mock("@/components/PowerMonitor", () => ({ PowerMonitor: () => null }))
vi.mock("@/components/DeviceSwitcher", () => ({ DeviceSwitcher: () => null }))
vi.mock("@/components/MissionControl/MissionControlButton", () => ({
  MissionControlButton: () => null,
}))

const PROPS = {
  showSidebar: true,
  showStats: false,
  killing: false,
  onGoHome: vi.fn(),
  onToggleSidebar: vi.fn(),
  onToggleStats: vi.fn(),
  onKillAll: vi.fn(),
  onOpenSettings: vi.fn(),
  onOpenCommandPalette: vi.fn(),
  commandPaletteShortcut: "⌘K",
}

describe("DesktopHeader", () => {
  beforeEach(() => {
    mocks.config = { networkUrl: null, defaultAgentKind: "claude" }
    mocks.session = { sessionId: "abcdef1234", cwd: "/tmp/project", slug: "my-session" }
    mocks.sessionSource = { dirName: "-tmp-project", fileName: "abcdef1234.jsonl", agentKind: "claude" }
    mocks.isLive = false
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it("copies the resume command from the session slug and offers no duplicate icon button", () => {
    render(<DesktopHeader {...PROPS} />)

    fireEvent.click(screen.getByRole("button", { name: /my-session/ }))

    expect(mocks.copy).toHaveBeenCalledWith(
      getResumeCommand("claude", "abcdef1234", "/tmp/project"),
    )
    expect(screen.queryByRole("button", { name: "Copy resume command" })).not.toBeInTheDocument()
  })

  it("renders no network readout while network access is off", () => {
    render(<DesktopHeader {...PROPS} />)

    expect(screen.queryByText("Network off")).not.toBeInTheDocument()
  })

  it("shows the connection URL while the machine is reachable on the network", () => {
    mocks.config = { networkUrl: "http://10.0.0.4:19384", defaultAgentKind: "claude" }
    render(<DesktopHeader {...PROPS} />)

    fireEvent.click(screen.getByRole("button", { name: /10\.0\.0\.4/ }))

    expect(mocks.copy).toHaveBeenCalledWith("http://10.0.0.4:19384")
  })

  it("keeps secondary workspace actions in the overflow menu", async () => {
    const user = userEvent.setup()
    render(<DesktopHeader {...PROPS} />)

    expect(screen.queryByRole("menuitem", { name: "Settings" })).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "More actions" }))
    await user.click(await screen.findByRole("menuitem", { name: "Settings" }))

    expect(PROPS.onOpenSettings).toHaveBeenCalledOnce()
  })
})
