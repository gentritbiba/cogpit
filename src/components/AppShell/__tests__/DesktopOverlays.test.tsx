import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DesktopOverlays } from "../DesktopOverlays"
import type { DesktopAppShellProps } from "../desktopTypes"
import { FIND_IN_CONVERSATION_EVENT } from "@/components/ChatArea"
import type { CommandPaletteProps } from "@/components/CommandPalette"
import type { useAppContext } from "@/contexts/AppContext"
import type { useSessionContext } from "@/contexts/SessionContext"

const mocks = vi.hoisted(() => ({
  useAppContext: vi.fn(),
  useSessionContext: vi.fn(),
  useDevices: vi.fn(),
}))

vi.mock("@/contexts/AppContext", () => ({ useAppContext: mocks.useAppContext }))
vi.mock("@/contexts/SessionContext", () => ({ useSessionContext: mocks.useSessionContext }))
vi.mock("@/hooks/useDevices", () => ({ useDevices: mocks.useDevices }))

// Keep the real FIND_IN_CONVERSATION_EVENT so this test breaks if the name
// the overlays dispatch ever drifts from the one ChatArea listens for.
vi.mock("@/components/ChatArea", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ChatArea")>()),
  ChatArea: () => null,
}))

vi.mock("@/components/ConfigDialog", () => ({ ConfigDialog: () => null }))
vi.mock("@/components/ProjectSwitcherModal", () => ({ ProjectSwitcherModal: () => null }))
vi.mock("@/components/ThemeSelectorModal", () => ({ ThemeSelectorModal: () => null }))
vi.mock("@/components/WorktreePanel", () => ({ WorktreePanel: () => null }))

vi.mock("@/components/KeyboardShortcutsDialog", () => ({
  KeyboardShortcutsDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="shortcuts-dialog" /> : null,
}))

vi.mock("@/components/DevicesDialog", () => ({
  DevicesDialog: ({ initialMode }: { initialMode: string }) => (
    <div data-testid="devices-dialog">{initialMode}</div>
  ),
}))

// Surface the palette callbacks under test as plain buttons.
vi.mock("@/components/CommandPaletteHost", () => ({
  CommandPaletteHost: (props: CommandPaletteProps) => (
    <div>
      <button onClick={() => props.onOpenDevices?.("manage")}>palette manage devices</button>
      <button onClick={() => props.onOpenDevices?.("add")}>palette add device</button>
      <button onClick={() => props.onCopyResumeCommand?.()}>palette copy resume</button>
      <button onClick={() => props.onFindInConversation?.()}>palette find</button>
      <span data-testid="palette-devices">
        {(props.devices ?? []).map((device) => device.name).join(",")}
      </span>
      <span data-testid="palette-kill-all">{props.onKillAll ? "yes" : "no"}</span>
    </div>
  ),
}))

const clipboardWrites: string[] = []
vi.mock("@/lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/utils")>()),
  copyToClipboard: (text: string) => {
    clipboardWrites.push(text)
    return Promise.resolve(true)
  },
}))

function setContexts(session: { sessionId: string; cwd: string } | null = null): void {
  mocks.useAppContext.mockReturnValue({
    state: {
      mainView: "sessions",
      pendingCwd: null,
      pendingDirName: null,
      dashboardProject: null,
    },
    config: { claudeDir: null, showConfigDialog: false },
    theme: { theme: "dark" },
  } as unknown as ReturnType<typeof useAppContext>)

  mocks.useSessionContext.mockReturnValue({
    session,
    sessionSource: session ? { dirName: "-workspace-cogpit", fileName: "s.jsonl" } : null,
  } as unknown as ReturnType<typeof useSessionContext>)
}

function makeProps(): Pick<DesktopAppShellProps, "navigation" | "project" | "chrome"> {
  return {
    navigation: {
      panels: {
        showSidebar: true,
        showStats: false,
        showWorktrees: false,
        showFileChanges: true,
        showProjectSwitcher: false,
        showThemeSelector: false,
        handleToggleSidebar: vi.fn(),
        handleToggleStats: vi.fn(),
        handleToggleWorktrees: vi.fn(),
        handleToggleFileChanges: vi.fn(),
        handleToggleConfig: vi.fn(),
        handleToggleMission: vi.fn(),
        handleOpenProjectSwitcher: vi.fn(),
        handleCloseProjectSwitcher: vi.fn(),
        handleToggleThemeSelector: vi.fn(),
        handleCloseThemeSelector: vi.fn(),
        setShowWorktrees: vi.fn(),
      },
      actions: {
        handleDashboardSelect: vi.fn(),
        handleGoHome: vi.fn(),
        handleJumpToTurn: vi.fn(),
      },
      handlers: {
        handleDuplicateSessionByPath: vi.fn(),
        handleDuplicateSession: vi.fn(),
        handleDeleteSession: vi.fn(),
        handleLoadSessionScrollAware: vi.fn(),
      },
    },
    project: {
      worktrees: { worktrees: [], loading: false, refetch: vi.fn() },
      processPanel: { addProcess: vi.fn() },
      supportsWorktrees: false,
      hasFileChanges: false,
      currentCwd: "/workspace/cogpit",
      showProjectFiles: false,
      launchTerminalRequest: 0,
      onOpenTerminal: vi.fn(),
      onTogglePreview: vi.fn(),
      onToggleProjectFiles: vi.fn(),
    },
    chrome: {
      commandPaletteOpen: false,
      onCommandPaletteOpenChange: vi.fn(),
      onFocusComposer: vi.fn(),
      onExpandAll: vi.fn(),
      onCollapseAll: vi.fn(),
      keyboardShortcutsOpen: false,
      onKeyboardShortcutsOpenChange: vi.fn(),
      onKillAll: vi.fn(),
    },
  } as unknown as Pick<DesktopAppShellProps, "navigation" | "project" | "chrome">
}

describe("DesktopOverlays", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clipboardWrites.length = 0
    setContexts()
    mocks.useDevices.mockReturnValue({ devices: [], activeDeviceId: "local" })
  })

  describe("? opens the keyboard shortcut reference", () => {
    function pressQuestionMark(): void {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "?",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }))
    }

    it("opens the dialog when nothing is being typed into", () => {
      const props = makeProps()
      render(<DesktopOverlays {...props} />)

      pressQuestionMark()

      expect(props.chrome.onKeyboardShortcutsOpenChange).toHaveBeenCalledWith(true)
    })

    it("stays inert while a text field has focus", () => {
      const props = makeProps()
      render(<DesktopOverlays {...props} />)
      const input = document.createElement("input")
      document.body.appendChild(input)
      input.focus()

      pressQuestionMark()

      expect(props.chrome.onKeyboardShortcutsOpenChange).not.toHaveBeenCalled()
      document.body.removeChild(input)
    })
  })

  it("opens the devices dialog from the palette so it survives a hidden header switcher", async () => {
    const user = userEvent.setup()
    render(<DesktopOverlays {...makeProps()} />)

    expect(screen.queryByTestId("devices-dialog")).not.toBeInTheDocument()

    await user.click(screen.getByText("palette add device"))
    await waitFor(() => expect(screen.getByTestId("devices-dialog")).toHaveTextContent("add"))
  })

  it("offers every configured device to the palette, local machine first", () => {
    mocks.useDevices.mockReturnValue({
      devices: [{ id: "dev_1", name: "Studio" }],
      activeDeviceId: "dev_1",
    })
    render(<DesktopOverlays {...makeProps()} />)

    expect(screen.getByTestId("palette-devices")).toHaveTextContent("This machine,Studio")
  })

  it("copies the provider resume command for the open session", async () => {
    const user = userEvent.setup()
    setContexts({ sessionId: "abc-123", cwd: "/workspace/cogpit" })
    render(<DesktopOverlays {...makeProps()} />)

    await user.click(screen.getByText("palette copy resume"))

    expect(clipboardWrites).toEqual(["claude --resume abc-123"])
  })

  it("asks the open conversation to show its find bar", async () => {
    const user = userEvent.setup()
    const onFind = vi.fn()
    setContexts({ sessionId: "abc-123", cwd: "/workspace/cogpit" })
    window.addEventListener(FIND_IN_CONVERSATION_EVENT, onFind)
    render(<DesktopOverlays {...makeProps()} />)

    await user.click(screen.getByText("palette find"))

    expect(onFind).toHaveBeenCalled()
    window.removeEventListener(FIND_IN_CONVERSATION_EVENT, onFind)
  })
})
