import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { DesktopWorkspace } from "../DesktopWorkspace"
import type { DesktopAppShellProps } from "../desktopTypes"
import type { ParsedSession } from "@/lib/types"
import type { useAppContext } from "@/contexts/AppContext"
import type { useSessionContext } from "@/contexts/SessionContext"

const contextMocks = vi.hoisted(() => ({
  useAppContext: vi.fn(),
  useSessionContext: vi.fn(),
}))

vi.mock("@/contexts/AppContext", () => ({
  useAppContext: contextMocks.useAppContext,
}))

vi.mock("@/contexts/SessionContext", () => ({
  useSessionContext: contextMocks.useSessionContext,
}))

vi.mock("@/components/HoverRevealPanel", () => ({
  HoverRevealPanel: ({ side, children }: { side: string; children: ReactNode }) => (
    <section data-testid={`${side}-panel`}>{children}</section>
  ),
}))

vi.mock("@/components/SessionBrowser", () => ({
  SessionBrowser: ({ sessionId }: { sessionId: string | null }) => (
    <div data-testid="session-browser">{sessionId ?? "no-session"}</div>
  ),
}))

vi.mock("@/components/Dashboard", () => ({
  Dashboard: () => <div data-testid="dashboard" />,
}))

vi.mock("@/components/ChatArea", () => ({
  ChatArea: () => <div data-testid="chat-area" />,
}))

vi.mock("@/components/SessionInfoBar", () => ({
  SessionInfoBar: () => <div data-testid="session-info" />,
}))

vi.mock("@/components/SessionStatusBar", () => ({
  SessionStatusBar: ({ session }: { session: ParsedSession }) => (
    <div data-testid="session-status">{session.sessionId}</div>
  ),
}))

vi.mock("@/components/StatsPanel", () => ({
  StatsPanel: () => <div data-testid="stats-panel" />,
}))

vi.mock("@/components/FileChangesPanel", () => ({
  FileChangesPanel: () => <div data-testid="file-changes" />,
}))

vi.mock("@/components/TodoProgressPanel", () => ({
  TodoProgressPanel: () => <div data-testid="todo-progress" />,
}))

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => <div data-testid="resize-handle" />,
}))

vi.mock("@/components/ConfigBrowser", () => ({
  ConfigBrowser: ({ projectPath }: { projectPath: string | null }) => (
    <div data-testid="config-browser">{projectPath ?? "no-project"}</div>
  ),
}))

vi.mock("@/components/TeamsDashboard", () => ({
  TeamsDashboard: ({ teamName }: { teamName: string }) => (
    <div data-testid="teams-dashboard">{teamName}</div>
  ),
}))

vi.mock("@/components/PreviewPanel", () => ({
  PreviewPanel: ({ cwd }: { cwd: string }) => <div data-testid="preview-panel">{cwd}</div>,
}))

vi.mock("@/components/ProjectFilesPanel", () => ({
  ProjectFilesPanel: ({ cwd }: { cwd: string }) => <div data-testid="project-files-panel">{cwd}</div>,
}))

function makeSession(overrides: Partial<ParsedSession> = {}): ParsedSession {
  return {
    sessionId: "session-1",
    version: "1.0",
    gitBranch: "",
    cwd: "/workspace/current",
    slug: "test",
    name: "",
    model: "",
    turns: [],
    stats: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      totalCostUSD: 0,
      toolCallCounts: {},
      errorCount: 0,
      totalDurationMs: 0,
      turnCount: 0,
    },
    rawMessages: [],
    ...overrides,
  }
}

function setContexts({
  mainView = "sessions",
  selectedTeam = null,
  pendingDirName = null,
  pendingCwd = null,
  session = null,
}: {
  mainView?: "sessions" | "teams" | "config"
  selectedTeam?: string | null
  pendingDirName?: string | null
  pendingCwd?: string | null
  session?: ParsedSession | null
} = {}): void {
  contextMocks.useAppContext.mockReturnValue({
    state: {
      session: null,
      sessionSource: null,
      pendingDirName,
      pendingCwd,
      activeTurnIndex: null,
      activeToolCallId: null,
      searchQuery: "",
      expandAll: false,
      sessionChangeKey: 1,
      currentMemberName: null,
      loadingMember: null,
      mainView,
      configFilePath: null,
      selectedTeam,
      sidebarTab: "live",
      mobileTab: "sessions",
      dashboardProject: null,
    },
  } as ReturnType<typeof useAppContext>)

  contextMocks.useSessionContext.mockReturnValue({
    session,
    sessionSource: session ? {
      dirName: "-workspace-current",
      fileName: "session-1.jsonl",
      rawText: "",
    } : null,
    isSubAgentView: false,
  } as ReturnType<typeof useSessionContext>)
}

function makeProps(
  overrides: Partial<Pick<DesktopAppShellProps, "navigation" | "sessionView" | "project">> = {},
): Pick<DesktopAppShellProps, "navigation" | "sessionView" | "project"> {
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
        handleOpenProjectSwitcher: vi.fn(),
        handleCloseProjectSwitcher: vi.fn(),
        handleToggleThemeSelector: vi.fn(),
        handleCloseThemeSelector: vi.fn(),
        setShowWorktrees: vi.fn(),
      },
      actions: {
        handleLoadSession: vi.fn(),
        handleDashboardSelect: vi.fn(),
        handleSelectTeam: vi.fn(),
        handleBackFromTeam: vi.fn(),
        handleOpenSessionFromTeam: vi.fn(),
        handleGoHome: vi.fn(),
        handleJumpToTurn: vi.fn(),
      },
      handlers: {
        handleDuplicateSessionByPath: vi.fn(),
        handleDuplicateSession: vi.fn(),
        handleDeleteSession: vi.fn(),
        handleLoadSessionScrollAware: vi.fn(),
      },
      creatingSession: false,
      pendingSession: null,
      onSidebarTabChange: vi.fn(),
      onStartNewSession: vi.fn(),
      onStartNewFolder: vi.fn(),
      onSelectProject: vi.fn(),
      onOpenPaletteProject: vi.fn(),
      onBeforeSessionSwitch: vi.fn(),
      liveSessionsRefreshRef: { current: null },
      onPrefetchSession: vi.fn(),
    },
    sessionView: {
      searchInputRef: { current: null },
      chatInputRef: { current: null },
      teamMembersBar: null,
      agentContextBar: null,
      activeComposer: <div data-testid="active-composer" />,
      pendingComposer: <div data-testid="pending-composer" />,
      pendingTurns: [],
      todoProgress: null,
      todosExpanded: false,
      onTodosExpandedChange: vi.fn(),
      hasMoreTurns: false,
      onLoadMoreTurns: vi.fn(),
      onBackToMain: vi.fn(),
      onShowWorkflows: vi.fn(),
      workflowCount: 0,
      fileChangesCollapsed: false,
      onFileChangesPanelResize: vi.fn(),
    },
    project: {
      processPanel: {
        addProcess: vi.fn(),
        handleServersChanged: vi.fn(),
        handleToggleServer: vi.fn(),
      },
      worktrees: { worktrees: [], loading: false, refetch: vi.fn() },
      backgroundAgents: [],
      supportsWorktrees: true,
      hasFileChanges: false,
      currentCwd: undefined,
      showPreview: false,
      showProjectFiles: false,
      launchTerminalRequest: 0,
      onOpenTerminal: vi.fn(),
      onTogglePreview: vi.fn(),
      onToggleProjectFiles: vi.fn(),
      onCloseRightWorkspace: vi.fn(),
      onPostProjectAction: vi.fn(),
    },
    ...overrides,
  }
}

describe("DesktopWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("renders the fresh SessionContext session when AppContext intentionally omits it", () => {
    setContexts({ session: makeSession() })

    render(<DesktopWorkspace {...makeProps()} />)

    expect(screen.getByTestId("session-browser")).toHaveTextContent("session-1")
    expect(screen.getByTestId("session-status")).toHaveTextContent("session-1")
    expect(screen.getByTestId("active-composer")).toBeInTheDocument()
  })

  it("gives config precedence and resolves the fresh session cwd", async () => {
    setContexts({ mainView: "config", session: makeSession({ cwd: "/fresh/session" }) })

    render(<DesktopWorkspace {...makeProps()} />)

    expect(await screen.findByTestId("config-browser")).toHaveTextContent("/fresh/session")
    expect(screen.queryByTestId("session-status")).not.toBeInTheDocument()
  })

  it("renders pending turns and the pending composer before the dashboard", () => {
    setContexts({ pendingDirName: "-workspace-pending", pendingCwd: "/workspace/pending" })
    const props = makeProps()
    props.sessionView.pendingTurns = [<div key="turn" data-testid="pending-turn" />]

    render(<DesktopWorkspace {...props} />)

    expect(screen.getByTestId("pending-turn")).toBeInTheDocument()
    expect(screen.getByTestId("pending-composer")).toBeInTheDocument()
    expect(screen.queryByTestId("dashboard")).not.toBeInTheDocument()
  })

  it("renders the shared project dashboard for the empty home state", () => {
    setContexts()

    render(<DesktopWorkspace {...makeProps()} />)

    expect(screen.getByTestId("dashboard")).toBeInTheDocument()
  })

  it("renders the shared selected-team dashboard", async () => {
    setContexts({ mainView: "teams", selectedTeam: "platform" })

    render(<DesktopWorkspace {...makeProps()} />)

    expect(await screen.findByTestId("teams-dashboard")).toHaveTextContent("platform")
  })
})
