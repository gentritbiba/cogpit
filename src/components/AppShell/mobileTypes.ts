import type { MutableRefObject, ReactNode, RefObject } from "react"
import type { ParsedSession } from "@/lib/types"
import type { BgAgent } from "@/hooks/useBackgroundAgents"
import type { useAppHandlers } from "@/hooks/useAppHandlers"
import type { useProcessPanel } from "@/hooks/useProcessPanel"
import type { useSessionActions } from "@/hooks/useSessionActions"

export type MobileSessionActions = Pick<
  ReturnType<typeof useSessionActions>,
  | "handleLoadSession"
  | "handleDashboardSelect"
  | "handleSelectTeam"
  | "handleBackFromTeam"
  | "handleOpenSessionFromTeam"
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
  actions: MobileSessionActions
  handlers: MobileAppHandlers
  creatingSession: boolean
  pendingSession: {
    dirName: string
    cwd?: string | null
    firstMessage?: string
  } | null
  onSidebarTabChange: (tab: "live" | "browse" | "teams") => void
  onStartNewSession: (dirName: string, cwd?: string) => void
  onSelectProject: (dirName: string | null) => void
  onBeforeSessionSwitch: () => void
  liveSessionsRefreshRef: MutableRefObject<(() => void) | null>
  onPrefetchSession: (dirName: string, fileName: string) => void
  /** Off-main-thread session parser from App's `useParserWorker`. */
  workerParse: (text: string) => Promise<ParsedSession>
}

export interface MobileSessionView {
  searchInputRef: RefObject<HTMLInputElement | null>
  teamMembersBar: ReactNode
  agentContextBar: ReactNode
  hasTeam: boolean
  activeComposer: ReactNode
  pendingComposer: ReactNode
  pendingTurns: ReactNode[]
  todoProgress: ReactNode
  hasMoreTurns: boolean
  onLoadMoreTurns: () => void
  onBackToMain: () => void
  onShowWorkflows: () => void
  onToggleExpandAll: () => void
  workflowCount: number
  pendingPath: string | null
}

export interface MobileProject {
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
  status: ReactNode
  fileChangesOpen: boolean
  onFileChangesOpenChange: (open: boolean) => void
  searchOpen: boolean
  onSearchOpenChange: (open: boolean) => void
}

export interface MobileAppShellProps {
  navigation: MobileNavigation
  sessionView: MobileSessionView
  project: MobileProject
  chrome: MobileChrome
}
