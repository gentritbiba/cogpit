import type { MutableRefObject, ReactNode, RefObject } from "react"
import type { PendingSessionInfo } from "@/components/session-browser/types"
import type { BgAgent } from "@/hooks/useBackgroundAgents"
import type { useAppHandlers } from "@/hooks/useAppHandlers"
import type { useProcessPanel } from "@/hooks/useProcessPanel"
import type { useSessionActions } from "@/hooks/useSessionActions"
import type { ChatInputHandle } from "@/components/ChatInput"
import type { DesktopPanels, DesktopWorktrees } from "./desktopTypes"
import type { BuiltInEditorRequest } from "@/lib/fileOpener"

export type MobileSessionActions = Pick<
  ReturnType<typeof useSessionActions>,
  | "handleDashboardSelect"
  | "handleMobileTabChange"
>

export type MobileAppHandlers = Pick<
  ReturnType<typeof useAppHandlers>,
  | "handleDuplicateSessionByPath"
  | "handleDuplicateSession"
  | "handleDeleteSession"
  | "handleMobileJumpToTurn"
  | "handleLoadSessionScrollAware"
>

export interface MobileNavigation {
  panels: Pick<DesktopPanels, "activeWorkspacePanel" | "openWorkspacePanel" | "closeWorkspacePanel">
  actions: MobileSessionActions
  handlers: MobileAppHandlers
  creatingSession: boolean
  pendingSession: PendingSessionInfo | null
  onStartNewSession: (dirName: string, cwd?: string) => void
  onSelectProject: (dirName: string | null) => void
  liveSessionsRefreshRef: MutableRefObject<(() => void) | null>
  onPrefetchSession: (dirName: string, fileName: string) => void
}

export interface MobileSessionView {
  chatInputRef: RefObject<ChatInputHandle | null>
  searchInputRef: RefObject<HTMLInputElement | null>
  teamMembersBar: ReactNode
  activeComposer: ReactNode
  pendingComposer: ReactNode
  pendingTurns: ReactNode[]
  todoProgress: ReactNode
  hasMoreTurns: boolean
  isLoadingOlderTurns: boolean
  onLoadMoreTurns: () => void
  onBackToMain: () => void
  onShowWorkflows: () => void
  onToggleExpandAll: () => void
  workflowCount: number
  pendingPath: string | null
}

export interface MobileProject {
  currentCwd: string | undefined
  supportsWorktrees: boolean
  worktrees: DesktopWorktrees
  projectFilesRoot: string | undefined
  projectFilesRequest: BuiltInEditorRequest | null
  processPanel: Pick<
    ReturnType<typeof useProcessPanel>,
    "handleToggleServer" | "handleServersChanged"
  >
  backgroundAgents: BgAgent[]
  hasFileChanges: boolean
  onOpenTerminal: () => void
}

export interface MobileChrome {
  backgroundServers: ReactNode
  processPanel: ReactNode
  workflowsPanel: ReactNode
  undoDialog: ReactNode
  branchModal: ReactNode
  fileChangesOpen: boolean
  onFileChangesOpenChange: (open: boolean) => void
}

export interface MobileAppShellProps {
  navigation: MobileNavigation
  sessionView: MobileSessionView
  project: MobileProject
  chrome: MobileChrome
}
