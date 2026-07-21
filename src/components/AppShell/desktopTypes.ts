import type {
  Dispatch,
  MutableRefObject,
  ReactNode,
  RefObject,
  SetStateAction,
} from "react"
import type { PanelSize } from "react-resizable-panels"
import type { ParsedSession } from "@/lib/types"
import type { ChatInputHandle } from "@/components/ChatInput"
import type { BgAgent } from "@/hooks/useBackgroundAgents"
import type { useAppHandlers } from "@/hooks/useAppHandlers"
import type { usePanelState } from "@/hooks/usePanelState"
import type { useProcessPanel } from "@/hooks/useProcessPanel"
import type { useSessionActions } from "@/hooks/useSessionActions"
import type { TodoProgress } from "@/hooks/useTodoProgress"
import type { useWorktrees } from "@/hooks/useWorktrees"

export type DesktopPanels = Pick<
  ReturnType<typeof usePanelState>,
  | "showSidebar"
  | "showStats"
  | "showWorktrees"
  | "showFileChanges"
  | "showProjectSwitcher"
  | "showThemeSelector"
  | "handleToggleSidebar"
  | "handleToggleStats"
  | "handleToggleWorktrees"
  | "handleToggleFileChanges"
  | "handleToggleConfig"
  | "handleOpenProjectSwitcher"
  | "handleCloseProjectSwitcher"
  | "handleToggleThemeSelector"
  | "handleCloseThemeSelector"
  | "setShowWorktrees"
>

export type DesktopSessionActions = Pick<
  ReturnType<typeof useSessionActions>,
  | "handleLoadSession"
  | "handleDashboardSelect"
  | "handleSelectTeam"
  | "handleBackFromTeam"
  | "handleOpenSessionFromTeam"
  | "handleGoHome"
  | "handleJumpToTurn"
>

export type DesktopAppHandlers = Pick<
  ReturnType<typeof useAppHandlers>,
  | "handleDuplicateSessionByPath"
  | "handleDuplicateSession"
  | "handleDeleteSession"
  | "handleLoadSessionScrollAware"
>

export type DesktopProcessPanel = Pick<
  ReturnType<typeof useProcessPanel>,
  "addProcess" | "handleServersChanged" | "handleToggleServer"
>

export type DesktopWorktrees = Pick<
  ReturnType<typeof useWorktrees>,
  "worktrees" | "loading" | "refetch"
>

export interface DesktopNavigation {
  panels: DesktopPanels
  actions: DesktopSessionActions
  handlers: DesktopAppHandlers
  creatingSession: boolean
  pendingSession: {
    dirName: string
    cwd?: string | null
    firstMessage?: string
  } | null
  onSidebarTabChange: (tab: "live" | "browse" | "teams") => void
  onStartNewSession: (dirName: string, cwd?: string) => void
  onStartNewFolder: (cwd: string) => void
  onSelectProject: (dirName: string | null) => void
  onOpenPaletteProject: (dirName: string) => void
  onBeforeSessionSwitch: () => void
  liveSessionsRefreshRef: MutableRefObject<(() => void) | null>
  onPrefetchSession: (dirName: string, fileName: string) => void
  /** Off-main-thread session parser from App's `useParserWorker`. */
  workerParse: (text: string) => Promise<ParsedSession>
}

export interface DesktopSessionView {
  searchInputRef: RefObject<HTMLInputElement | null>
  chatInputRef: RefObject<ChatInputHandle | null>
  teamMembersBar: ReactNode
  agentContextBar: ReactNode
  activeComposer: ReactNode
  pendingComposer: ReactNode
  pendingTurns: ReactNode[]
  todoProgress: TodoProgress | null
  todosExpanded: boolean
  onTodosExpandedChange: (expanded: boolean) => void
  hasMoreTurns: boolean
  onLoadMoreTurns: () => void
  onBackToMain: () => void
  onShowWorkflows: () => void
  workflowCount: number
  fileChangesCollapsed: boolean
  onFileChangesPanelResize: (size: PanelSize) => void
}

export interface DesktopProject {
  processPanel: DesktopProcessPanel
  worktrees: DesktopWorktrees
  backgroundAgents: BgAgent[]
  supportsWorktrees: boolean
  hasFileChanges: boolean
  currentCwd: string | undefined
  showPreview: boolean
  showProjectFiles: boolean
  launchTerminalRequest: number
  onOpenTerminal: () => void
  onTogglePreview: () => void
  onToggleProjectFiles: () => void
  onCloseRightWorkspace: () => void
  onPostProjectAction: (
    endpoint: "/api/open-in-editor" | "/api/reveal-in-folder",
  ) => void
}

export interface DesktopChrome {
  backgroundServers: ReactNode
  processPanel: ReactNode
  workflowsPanel: ReactNode
  undoDialog: ReactNode
  branchModal: ReactNode
  status: ReactNode
  killing: boolean
  onKillAll: () => void
  commandPaletteOpen: boolean
  onCommandPaletteOpenChange: Dispatch<SetStateAction<boolean>>
  onOpenCommandPalette: () => void
  onFocusComposer: () => void
  onExpandAll: () => void
  onCollapseAll: () => void
  keyboardShortcutsOpen: boolean
  onKeyboardShortcutsOpenChange: Dispatch<SetStateAction<boolean>>
}

export interface DesktopAppShellProps {
  navigation: DesktopNavigation
  sessionView: DesktopSessionView
  project: DesktopProject
  chrome: DesktopChrome
}
