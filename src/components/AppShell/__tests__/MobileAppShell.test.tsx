import { useState, type ReactNode } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { Users } from "lucide-react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MobileAppShell } from "../MobileAppShell"
import type { MobileAppShellProps } from "../mobileTypes"
import type { MobileTab } from "@/components/MobileNav"
import type { AccountControlProps, EditionMainView } from "@/edition/contract"
import { __installEditionUiForTest, __resetEditionUiForTest } from "@/edition/registry"
import type { MainView } from "@/hooks/useSessionState"

const mocks = vi.hoisted(() => ({ tab: "chat" as MobileTab, mainView: "sessions" as MainView }))
vi.mock("@/contexts/AppContext", () => ({
  useAppContext: () => ({
    state: { mobileTab: mocks.tab, mainView: mocks.mainView, extensionViewId: "reports", pendingDirName: null },
    config: { defaultAgentKind: "claude" },
  }),
}))
vi.mock("@/contexts/SessionContext", () => ({ useSessionContext: () => ({ session: {}, isSubAgentView: false }) }))
vi.mock("@/components/ChatArea", () => ({
  ChatArea: function ChatArea() {
    const [expanded, setExpanded] = useState(false)
    return <button onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>Tool details</button>
  },
}))
vi.mock("../MobileWorkspace", () => ({ MobileWorkspace: () => <div>Workspace tools</div> }))
vi.mock("@/components/DeviceSwitcher", () => ({ DeviceSwitcher: () => null }))
vi.mock("@/components/SessionInfoBar", () => ({
  SessionInfoBar: ({ headerAccessory }: { headerAccessory?: ReactNode }) => <>{headerAccessory}</>,
}))
vi.mock("@/components/ProviderUpdateBanner", () => ({ ProviderUpdateBanner: () => null }))
vi.mock("@/components/UpdateBanner", () => ({ UpdateBanner: () => null }))
vi.mock("../SharedAppViews", () => ({
  PrimarySessionBrowser: () => <div>Session list</div>,
  ProjectDashboard: () => null,
  ExtensionMainView: ({ view }: { view: EditionMainView }) => <div>{view.label} view</div>,
}))

function AccountControl({ onLogout, onOpenMainView }: AccountControlProps) {
  return (
    <>
      <button onClick={onLogout}>Account</button>
      <button onClick={() => onOpenMainView("reports")}>Reports</button>
    </>
  )
}

function reportsView({ available = true, locksSwipe = true } = {}): EditionMainView {
  return {
    id: "reports",
    label: "Reports",
    icon: Users,
    keywords: "reports",
    isAvailable: () => available,
    locksSwipe,
    Component: () => null,
  }
}

function swipeLeft(): void {
  const main = screen.getByRole("main")
  fireEvent.touchStart(main, { touches: [{ clientX: 200, clientY: 0 }] })
  fireEvent.touchEnd(main, { changedTouches: [{ clientX: 100, clientY: 0 }] })
}

function Composer() {
  const [text, setText] = useState("")
  return <input aria-label="Draft" value={text} onChange={(event) => setText(event.target.value)} />
}

function props(): MobileAppShellProps {
  return {
    navigation: {
      panels: {
        activeWorkspacePanel: null, openWorkspacePanel: vi.fn(), closeWorkspacePanel: vi.fn(),
        openMainView: vi.fn(), closeMainView: vi.fn(),
      },
      actions: { handleDashboardSelect: vi.fn(), handleMobileTabChange: (tab) => { mocks.tab = tab } },
      handlers: {
        handleDuplicateSessionByPath: vi.fn(), handleDuplicateSession: vi.fn(), handleDeleteSession: vi.fn(),
        handleMobileJumpToTurn: vi.fn(), handleLoadSessionScrollAware: vi.fn(),
      },
      creatingSession: false, pendingSession: null, onStartNewSession: vi.fn(), onStartNewFolder: vi.fn(), onSelectProject: vi.fn(),
      liveSessionsRefreshRef: { current: null }, onPrefetchSession: vi.fn(),
    },
    sessionView: {
      chatInputRef: { current: null }, searchInputRef: { current: null }, teamMembersBar: null,
      activeComposer: <Composer />, pendingComposer: null, pendingTurns: [], todoProgress: null,
      hasMoreTurns: false, isLoadingOlderTurns: false, onLoadMoreTurns: vi.fn(), onBackToMain: vi.fn(),
      onShowWorkflows: vi.fn(), onToggleExpandAll: vi.fn(), workflowCount: 0, pendingPath: null,
    },
    project: {
      currentCwd: "/repo", supportsWorktrees: true, worktrees: { worktrees: [], loading: false, refetch: vi.fn() },
      projectFilesRoot: undefined, projectFilesRequest: null, processPanel: { handleToggleServer: vi.fn(), handleServersChanged: vi.fn() },
      backgroundAgents: [], hasFileChanges: false, onOpenTerminal: vi.fn(),
    },
    chrome: {
      backgroundServers: null, processPanel: null, workflowsPanel: null, undoDialog: null, branchModal: null,
      fileChangesOpen: false, onFileChangesOpenChange: vi.fn(), onLogout: vi.fn(),
    },
  }
}

beforeEach(() => {
  mocks.tab = "chat"
  mocks.mainView = "sessions"
})
afterEach(() => {
  cleanup()
  __resetEditionUiForTest()
})

describe("mobile chat continuity", () => {
  it("preserves expanded tools and composer drafts across workspace and session navigation", () => {
    const values = props()
    const { rerender } = render(<MobileAppShell {...values} />)
    fireEvent.click(screen.getByRole("button", { name: "Tool details" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Draft" }), { target: { value: "Keep this draft" } })

    for (const destination of ["Workspace", "Sessions"]) {
      fireEvent.click(screen.getByRole("button", { name: destination }))
      rerender(<MobileAppShell {...values} />)
      expect(screen.queryByRole("button", { name: "Tool details" })).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole("button", { name: "Chat" }))
      rerender(<MobileAppShell {...values} />)
      expect(screen.getByRole("button", { name: "Tool details" })).toHaveAttribute("aria-expanded", "true")
      expect(screen.getByRole("textbox", { name: "Draft" })).toHaveValue("Keep this draft")
    }
  })
})

describe("mobile shell header", () => {
  it("carries the edition's account control, wired to the shell's logout and main views", () => {
    __installEditionUiForTest({ AccountControl })
    mocks.tab = "sessions"
    const values = props()
    render(<MobileAppShell {...values} />)

    fireEvent.click(screen.getByRole("button", { name: "Account" }))
    fireEvent.click(screen.getByRole("button", { name: "Reports" }))

    expect(values.chrome.onLogout).toHaveBeenCalledOnce()
    expect(values.navigation.panels.openMainView).toHaveBeenCalledWith("reports")
  })

  it("carries no account control without an edition", () => {
    mocks.tab = "sessions"
    render(<MobileAppShell {...props()} />)

    expect(screen.queryByRole("button", { name: "Account" })).not.toBeInTheDocument()
  })
})

describe("mobile chat header", () => {
  it("keeps the account control within reach while a chat is open", () => {
    __installEditionUiForTest({ AccountControl })
    const values = props()
    render(<MobileAppShell {...values} />)

    fireEvent.click(screen.getByRole("button", { name: "Account" }))

    expect(values.chrome.onLogout).toHaveBeenCalledOnce()
  })
})

describe("mobile edition main view", () => {
  it("covers the tabs and closes when a tab is chosen", () => {
    __installEditionUiForTest({ mainViews: [reportsView()] })
    mocks.mainView = "extension"
    const values = props()
    render(<MobileAppShell {...values} />)

    expect(screen.getByText("Reports view")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Sessions" }))

    expect(values.navigation.panels.closeMainView).toHaveBeenCalledOnce()
  })

  it("never renders once the caller may not open it", () => {
    __installEditionUiForTest({ mainViews: [reportsView({ available: false })] })
    mocks.mainView = "extension"
    render(<MobileAppShell {...props()} />)

    expect(screen.queryByText("Reports view")).not.toBeInTheDocument()
  })

  it.each([
    [true, "chat"],
    [false, "workspace"],
  ] as const)("holds the tab swipe while open when it asks to (%s)", (locksSwipe, tabAfterSwipe) => {
    __installEditionUiForTest({ mainViews: [reportsView({ locksSwipe })] })
    mocks.mainView = "extension"
    render(<MobileAppShell {...props()} />)

    swipeLeft()

    expect(mocks.tab).toBe(tabAfterSwipe)
  })
})
