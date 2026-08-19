import { lazy, Suspense, type MutableRefObject } from "react"
import { Dashboard } from "@/components/Dashboard"
import { SessionBrowser } from "@/components/session-browser"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext } from "@/contexts/SessionContext"
import type { useAppHandlers } from "@/hooks/useAppHandlers"
import type { useSessionActions } from "@/hooks/useSessionActions"

const MissionControl = lazy(() => import("@/components/MissionControl").then((module) => ({ default: module.MissionControl })))

type ShellActions = Pick<
  ReturnType<typeof useSessionActions>,
  "handleDashboardSelect"
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
  onStartNewSession: (dirName: string, cwd?: string) => void
  onSelectProject: (dirName: string | null) => void
  liveSessionsRefreshRef: MutableRefObject<(() => void) | null>
  onPrefetchSession: (dirName: string, fileName: string) => void
}

interface PrimarySessionBrowserProps {
  navigation: ShellNavigation
  mobile?: boolean
}

/** Canonical primary session navigation shared by desktop and mobile shells. */
export function PrimarySessionBrowser({
  navigation,
  mobile = false,
}: PrimarySessionBrowserProps) {
  const { sessionSource } = useSessionContext()
  const activeSessionKey = sessionSource
    ? `${sessionSource.dirName}/${sessionSource.fileName}`
    : null

  return (
    <SessionBrowser
      activeSessionKey={activeSessionKey}
      onSelectSession={navigation.actions.handleDashboardSelect}
      onNewSession={navigation.onStartNewSession}
      creatingSession={navigation.creatingSession}
      pendingSession={navigation.pendingSession}
      onDuplicateSession={navigation.handlers.handleDuplicateSessionByPath}
      onDeleteSession={navigation.handlers.handleDeleteSession}
      liveSessionsRefreshRef={navigation.liveSessionsRefreshRef}
      onPrefetchSession={navigation.onPrefetchSession}
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

/** Mission Control grid, shared by desktop and mobile shells. */
export function MissionControlView({ navigation }: { navigation: ShellNavigation }) {
  return (
    <Suspense fallback={null}>
      <MissionControl onSelectSession={navigation.actions.handleDashboardSelect} />
    </Suspense>
  )
}
