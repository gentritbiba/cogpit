import { lazy, Suspense, useState, type MutableRefObject, type ReactNode } from "react"
import { ArrowLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ProjectSwitcherList, useProjectList } from "@/components/ProjectSwitcherList"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Dashboard } from "@/components/Dashboard"
import { SessionBrowser } from "@/components/session-browser"
import { Spinner } from "@/components/ui/Spinner"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext } from "@/contexts/SessionContext"
import type { EditionMainView } from "@/edition/contract"
import type { PendingSessionInfo } from "@/components/session-browser/types"
import type { useAppHandlers } from "@/hooks/useAppHandlers"
import type { useSessionActions } from "@/hooks/useSessionActions"

const MissionHome = lazy(() => import("@/components/home/MissionHome").then((module) => ({ default: module.MissionHome })))

export function LazyViewFallback({ label }: { label: string }) {
  return (
    <div
      className="motion-enter flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"
      role="status"
    >
      <Spinner className="size-4" />
      {label}
    </div>
  )
}

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
  pendingSession: PendingSessionInfo | null
  onStartNewSession: (dirName: string, cwd?: string) => void
  onStartNewFolder: (cwd: string) => void
  onSelectProject: (dirName: string | null) => void
  liveSessionsRefreshRef: MutableRefObject<(() => void) | null>
  onPrefetchSession: (dirName: string, fileName: string) => void
}

interface PrimarySessionBrowserProps {
  navigation: ShellNavigation
  mobile?: boolean
  header?: ReactNode
}

/** Canonical primary session navigation shared by desktop and mobile shells. */
export function PrimarySessionBrowser({
  navigation,
  mobile = false,
  header,
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
      header={header}
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

/** The home and its project history, shared by desktop and mobile shells. */
export function MissionControlView({ navigation, showProjectHistory = false }: { navigation: ShellNavigation; showProjectHistory?: boolean }) {
  const { state } = useAppContext()
  const [browsing, setBrowsing] = useState(false)
  return (
    <Suspense fallback={<LazyViewFallback label="Loading Mission Control…" />}>
      <div className="motion-session-enter flex min-h-0 flex-1 flex-col">
        {browsing || (showProjectHistory && state.dashboardProject) ? (
          <>
            <div className="px-4 pt-12">
              <Button variant="ghost" size="sm" onClick={() => { navigation.onSelectProject(null); setBrowsing(false) }}>
                <ArrowLeft data-icon="inline-start" /> Mission Control
              </Button>
            </div>
            <ProjectDashboard navigation={navigation} />
          </>
        ) : (
          <MissionHome
            onOpenSession={navigation.actions.handleDashboardSelect}
            onBrowseProjects={() => setBrowsing(true)}
            newSessionControl={<HomeSessionStart navigation={navigation} />}
          />
        )}
      </div>
    </Suspense>
  )
}

function HomeSessionStart({ navigation }: { navigation: ShellNavigation }) {
  const { config } = useAppContext()
  const [open, setOpen] = useState(false)
  const projects = useProjectList(open)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="outline" className="h-auto w-full justify-between px-4 py-4" />}>
        What should we build?
        <span className="text-muted-foreground">Choose a project</span>
      </PopoverTrigger>
      <PopoverContent className="w-96 max-w-[calc(100vw-2rem)] p-0">
        <ProjectSwitcherList
          projects={projects}
          defaultAgentKind={config.defaultAgentKind}
          onNewSession={(dirName, cwd) => { setOpen(false); navigation.onStartNewSession(dirName, cwd) }}
          onNewFolder={(cwd) => { setOpen(false); navigation.onStartNewFolder(cwd) }}
        />
      </PopoverContent>
    </Popover>
  )
}

/** A main view an edition registers, shared by desktop and mobile shells. Callers check it is available. */
export function ExtensionMainView({ view, onClose }: { view: EditionMainView; onClose: () => void }) {
  const { Component } = view
  return (
    <Suspense fallback={<LazyViewFallback label={`Loading ${view.label}…`} />}>
      <div className="motion-session-enter flex min-h-0 flex-1 flex-col">
        <Component onClose={onClose} />
      </div>
    </Suspense>
  )
}
