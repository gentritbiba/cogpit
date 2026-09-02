import type {
  Dispatch,
  MutableRefObject,
  ReactNode,
  RefObject,
  SetStateAction,
} from "react"
import type { ChatInputHandle } from "@/components/ChatInput"
import type { BgAgent } from "@/hooks/useBackgroundAgents"
import type { useAppHandlers } from "@/hooks/useAppHandlers"
import type { usePanelState } from "@/hooks/usePanelState"
import type { useProcessPanel } from "@/hooks/useProcessPanel"
import type { useSessionActions } from "@/hooks/useSessionActions"
import type { TodoProgress } from "@/hooks/useTodoProgress"
import type { useWorktrees } from "@/hooks/useWorktrees"
import type { BuiltInEditorRequest, ProjectRef } from "@/lib/fileOpener"

export type DesktopPanels = Pick<
  ReturnType<typeof usePanelState>,
  | "showSidebar"
  | "showWorktrees"
  | "activeWorkspacePanel"
  | "showProjectSwitcher"
  | "showThemeSelector"
  | "handleToggleSidebar"
  | "handleToggleWorktrees"
  | "toggleWorkspacePanel"
  | "openWorkspacePanel"
  | "closeWorkspacePanel"
  | "handleToggleConfig"
  | "handleToggleMission"
  | "handleOpenProjectSwitcher"
  | "handleCloseProjectSwitcher"
  | "handleToggleThemeSelector"
  | "handleCloseThemeSelector"
  | "setShowWorktrees"
>

export type DesktopSessionActions = Pick<
  ReturnType<typeof useSessionActions>,
  | "handleDashboardSelect"
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
  onStartNewSession: (dirName: string, cwd?: string) => void
  onStartNewFolder: (cwd: string) => void
  onSelectProject: (dirName: string | null) => void
  onOpenPaletteProject: (dirName: string) => void
  liveSessionsRefreshRef: MutableRefObject<(() => void) | null>
  onPrefetchSession: (dirName: string, fileName: string) => void
}

export interface DesktopSessionView {
  searchInputRef: RefObject<HTMLInputElement | null>
  chatInputRef: RefObject<ChatInputHandle | null>
  teamMembersBar: ReactNode
  activeComposer: ReactNode
  pendingComposer: ReactNode
  pendingTurns: ReactNode[]
  todoProgress: TodoProgress | null
  todosExpanded: boolean
  onTodosExpandedChange: (expanded: boolean) => void
  hasMoreTurns: boolean
  isLoadingOlderTurns: boolean
  onLoadMoreTurns: () => void
  onBackToMain: () => void
  onShowWorkflows: () => void
  workflowCount: number
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
  /** Directory the file workspace browses; absent when it is closed. */
  projectFilesRoot: string | undefined
  projectFilesRequest: BuiltInEditorRequest | null
  launchTerminalRequest: number
  /** Project a pending (not yet started) session would run in. */
  pendingProject: ProjectRef
  onOpenTerminal: () => void
  onTogglePreview: () => void
  onToggleProjectFiles: () => void
  onCloseRightWorkspace: () => void
}

export interface DesktopChrome {
  backgroundServers: ReactNode
  processPanel: ReactNode
  workflowsPanel: ReactNode
  undoDialog: ReactNode
  branchModal: ReactNode
  killing: boolean
  onKillAll: () => void
  commandPaletteOpen: boolean
  onCommandPaletteOpenChange: Dispatch<SetStateAction<boolean>>
  onOpenCommandPalette: () => void
  onFocusComposer: () => void
  onExpandAll: () => void
  onExpandToolPayloads: () => void
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
