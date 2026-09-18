import { useState } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MobileAppShell } from "../MobileAppShell"
import type { MobileAppShellProps } from "../mobileTypes"
import type { MobileTab } from "@/components/MobileNav"

const mocks = vi.hoisted(() => ({ tab: "chat" as MobileTab }))
vi.mock("@/contexts/AppContext", () => ({ useAppContext: () => ({ state: { mobileTab: mocks.tab, pendingDirName: null } }) }))
vi.mock("@/contexts/SessionContext", () => ({ useSessionContext: () => ({ session: {}, isSubAgentView: false }) }))
vi.mock("@/components/ChatArea", () => ({
  ChatArea: function ChatArea() {
    const [expanded, setExpanded] = useState(false)
    return <button onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>Tool details</button>
  },
}))
vi.mock("../MobileWorkspace", () => ({ MobileWorkspace: () => <div>Workspace tools</div> }))
vi.mock("@/components/DeviceSwitcher", () => ({ DeviceSwitcher: () => null }))
vi.mock("@/components/SessionInfoBar", () => ({ SessionInfoBar: () => null }))
vi.mock("@/components/ProviderUpdateBanner", () => ({ ProviderUpdateBanner: () => null }))
vi.mock("@/components/UpdateBanner", () => ({ UpdateBanner: () => null }))
vi.mock("../SharedAppViews", () => ({ PrimarySessionBrowser: () => <div>Session list</div>, ProjectDashboard: () => null }))

function Composer() {
  const [text, setText] = useState("")
  return <input aria-label="Draft" value={text} onChange={(event) => setText(event.target.value)} />
}

function props(): MobileAppShellProps {
  return {
    navigation: {
      panels: { activeWorkspacePanel: null, openWorkspacePanel: vi.fn(), closeWorkspacePanel: vi.fn() },
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
      fileChangesOpen: false, onFileChangesOpenChange: vi.fn(),
    },
  }
}

beforeEach(() => { mocks.tab = "chat" })
afterEach(cleanup)

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
