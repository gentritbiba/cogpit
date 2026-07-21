import { lazy, Suspense, type ComponentProps, type MutableRefObject } from "react"
import { Dashboard } from "@/components/Dashboard"
import { SessionBrowser } from "@/components/SessionBrowser"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext } from "@/contexts/SessionContext"
import type { useAppHandlers } from "@/hooks/useAppHandlers"
import type { useSessionActions } from "@/hooks/useSessionActions"

const TeamsDashboard = lazy(() => import("@/components/TeamsDashboard").then((module) => ({ default: module.TeamsDashboard })))

type ShellActions = Pick<
  ReturnType<typeof useSessionActions>,
  | "handleLoadSession"
  | "handleDashboardSelect"
  | "handleSelectTeam"
  | "handleBackFromTeam"
  | "handleOpenSessionFromTeam"
>

type ShellHandlers = Pick<
  ReturnType<typeof useAppHandlers>,
  "handleDuplicateSessionByPath" | "handleDeleteSession"
>

interface ShellNavigation {
  actions: ShellActions
  handlers: ShellHandlers
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
  workerParse: ComponentProps<typeof SessionBrowser>["workerParse"]
}

interface PrimarySessionBrowserProps {
  navigation: ShellNavigation
  mobile?: boolean
  projectDir?: string | null
  onScriptStarted?: ComponentProps<typeof SessionBrowser>["onScriptStarted"]
}

/** Canonical primary session navigation shared by desktop and mobile shells. */
export function PrimarySessionBrowser({
  navigation,
  mobile = false,
  projectDir,
  onScriptStarted,
}: PrimarySessionBrowserProps) {
  const { state } = useAppContext()
  const { session, sessionSource } = useSessionContext()
  const activeSessionKey = sessionSource
    ? `${sessionSource.dirName}/${sessionSource.fileName}`
    : null

  return (
    <SessionBrowser
      sessionId={session?.sessionId ?? null}
      activeSessionKey={activeSessionKey}
      onLoadSession={navigation.actions.handleLoadSession}
      sidebarTab={state.sidebarTab}
      onSidebarTabChange={navigation.onSidebarTabChange}
      onSelectTeam={navigation.actions.handleSelectTeam}
      onNewSession={navigation.onStartNewSession}
      creatingSession={navigation.creatingSession}
      pendingSession={navigation.pendingSession}
      onDuplicateSession={navigation.handlers.handleDuplicateSessionByPath}
      onDeleteSession={navigation.handlers.handleDeleteSession}
      onBeforeSessionSwitch={navigation.onBeforeSessionSwitch}
      liveSessionsRefreshRef={navigation.liveSessionsRefreshRef}
      projectDir={projectDir}
      onScriptStarted={onScriptStarted}
      onPrefetchSession={navigation.onPrefetchSession}
      workerParse={navigation.workerParse}
      isMobile={mobile}
    />
  )
}

/** Canonical empty/home dashboard shared by desktop and mobile shells. */
export function ProjectDashboard({ navigation }: { navigation: ShellNavigation }) {
  const { state } = useAppContext()
  return (
    <Dashboard
      onSelectSession={navigation.actions.handleDashboardSelect}
      onNewSession={navigation.onStartNewSession}
      creatingSession={navigation.creatingSession}
      selectedProjectDirName={state.dashboardProject}
      onSelectProject={navigation.onSelectProject}
      onDuplicateSession={navigation.handlers.handleDuplicateSessionByPath}
      onDeleteSession={navigation.handlers.handleDeleteSession}
    />
  )
}

/** Selected-team dashboard with one lazy-loading policy for every shell. */
export function SelectedTeamDashboard({ navigation }: { navigation: ShellNavigation }) {
  const { state } = useAppContext()
  if (!state.selectedTeam) return null
  return (
    <Suspense fallback={null}>
      <TeamsDashboard
        teamName={state.selectedTeam}
        onBack={navigation.actions.handleBackFromTeam}
        onOpenSession={navigation.actions.handleOpenSessionFromTeam}
      />
    </Suspense>
  )
}
