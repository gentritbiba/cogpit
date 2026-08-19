import { lazy, Suspense, useMemo } from "react"
import { TerminalSquare } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ChatArea } from "@/components/ChatArea"
import { DeviceSwitcher } from "@/components/DeviceSwitcher"
import { MobileNav, type MobileTab } from "@/components/MobileNav"
import { SessionInfoBar } from "@/components/SessionInfoBar"
import { StatsPanel } from "@/components/StatsPanel"
import { UpdateBanner } from "@/components/UpdateBanner"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext } from "@/contexts/SessionContext"
import { useSwipeNavigation } from "@/hooks/useSwipeNavigation"
import { can } from "@/lib/capabilities"
import { hapticLight } from "@/lib/haptics"
import type { MobileAppShellProps } from "./mobileTypes"
import { adjacentMobileTab, visibleMobileTabs } from "./mobileView"
import { NewSessionHeadline } from "./NewSessionHero"
import {
  PrimarySessionBrowser,
  ProjectDashboard,
} from "./SharedAppViews"

const MobileFileChanges = lazy(() => import("@/components/MobileFileChanges").then((module) => ({ default: module.MobileFileChanges })))

/** Mobile-only application composition: tab navigation, content, and overlays. */
export function MobileAppShell({
  navigation,
  sessionView,
  project,
  chrome,
}: MobileAppShellProps) {
  const { state, theme } = useAppContext()
  const { session, isSubAgentView } = useSessionContext()

  const visibleTabs = useMemo(() => visibleMobileTabs({
    hasSession: Boolean(session),
    hasPendingSession: Boolean(state.pendingDirName),
  }),
    [session, state.pendingDirName],
  )

  const swipeRef = useSwipeNavigation<HTMLElement>({
    enabled: true,
    onSwipeLeft: () => {
      const nextTab = adjacentMobileTab(visibleTabs, state.mobileTab, 1)
      if (nextTab) {
        hapticLight()
        navigation.actions.handleMobileTabChange(nextTab)
      }
    },
    onSwipeRight: () => {
      const nextTab = adjacentMobileTab(visibleTabs, state.mobileTab, -1)
      if (nextTab) {
        hapticLight()
        navigation.actions.handleMobileTabChange(nextTab)
      }
    },
  })

  const changeTab = (tab: MobileTab): void => {
    chrome.onSearchOpenChange(false)
    navigation.actions.handleMobileTabChange(tab)
  }

  return (
    <div className={`${theme.themeClasses} flex h-dvh flex-col bg-background text-foreground`}>
      {chrome.backgroundServers}
      <UpdateBanner />
      {!(state.mobileTab === "chat" && session) && (
        <div className="flex h-12 shrink-0 items-center border-b bg-background px-2">
          <DeviceSwitcher compact />
        </div>
      )}
      <main ref={swipeRef} className="flex flex-1 min-h-0 overflow-hidden">
        {state.mobileTab === "sessions" && (
          <PrimarySessionBrowser navigation={navigation} mobile />
        )}

        {state.mobileTab === "chat" && (
          <div className="flex flex-1 min-h-0 flex-col min-w-0">
            {session ? (
              <div className="flex flex-1 min-h-0 flex-col">
                {sessionView.teamMembersBar}
                <SessionInfoBar
                  creatingSession={navigation.creatingSession}
                  onNewSession={navigation.onStartNewSession}
                  onDuplicateSession={navigation.handlers.handleDuplicateSession}
                  onOpenTerminal={project.onOpenTerminal}
                  onBackToMain={isSubAgentView ? sessionView.onBackToMain : undefined}
                  onShowFileChanges={() => chrome.onFileChangesOpenChange(true)}
                  hasFileChanges={project.hasFileChanges}
                  onShowWorkflows={sessionView.onShowWorkflows}
                  workflowCount={sessionView.workflowCount}
                  onSearch={() => chrome.onSearchOpenChange(true)}
                  expandAll={state.expandAll}
                  onToggleExpandAll={sessionView.onToggleExpandAll}
                />
                <ChatArea
                  searchInputRef={sessionView.searchInputRef}
                  hasMore={sessionView.hasMoreTurns}
                  isLoadingOlder={sessionView.isLoadingOlderTurns}
                  onLoadMore={sessionView.onLoadMoreTurns}
                  mobileSearchOpen={chrome.searchOpen}
                  onMobileSearchClose={() => chrome.onSearchOpenChange(false)}
                />
              </div>
            ) : state.pendingDirName ? (
              <div className="flex flex-1 min-h-0 flex-col">
                {sessionView.pendingTurns.length > 0 ? (
                  <div className="flex-1 overflow-y-auto px-1 py-3">
                    {sessionView.pendingTurns}
                  </div>
                ) : (
                  <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4">
                    <NewSessionHeadline projectPath={sessionView.pendingPath ?? null} />
                    {can("terminal") && (
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={project.onOpenTerminal}
                      >
                        <TerminalSquare data-icon="inline-start" />
                        Terminal
                      </Button>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <ProjectDashboard navigation={navigation} />
            )}
          </div>
        )}

        {state.mobileTab === "stats" && session && (
          <StatsPanel
            onJumpToTurn={navigation.handlers.handleMobileJumpToTurn}
            onToggleServer={project.processPanel.handleToggleServer}
            onServersChanged={project.processPanel.handleServersChanged}
            onLoadSession={navigation.handlers.handleLoadSessionScrollAware}
            backgroundAgents={project.backgroundAgents}
          />
        )}

      </main>

      {state.mobileTab === "chat" && chrome.processPanel}
      {chrome.workflowsPanel}
      {state.mobileTab === "chat" && (session || state.pendingDirName) && (
        <>
          {sessionView.todoProgress}
          {session ? sessionView.activeComposer : sessionView.pendingComposer}
        </>
      )}

      <MobileNav
        activeTab={state.mobileTab}
        onTabChange={changeTab}
      />

      {chrome.undoDialog}
      {chrome.branchModal}
      {session && project.hasFileChanges && (
        <Suspense fallback={null}>
          <MobileFileChanges
            open={chrome.fileChangesOpen}
            onClose={() => chrome.onFileChangesOpenChange(false)}
            session={session}
            sessionChangeKey={state.sessionChangeKey}
          />
        </Suspense>
      )}
    </div>
  )
}
