import { lazy, Suspense, useMemo } from "react"
import { TerminalSquare } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ChatArea } from "@/components/ChatArea"
import { DeviceSwitcher } from "@/components/DeviceSwitcher"
import { MobileNav, type MobileTab } from "@/components/MobileNav"
import { SessionBrowser } from "@/components/SessionBrowser"
import { SessionInfoBar } from "@/components/SessionInfoBar"
import { StatsPanel } from "@/components/StatsPanel"
import { UpdateBanner } from "@/components/UpdateBanner"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext } from "@/contexts/SessionContext"
import { useSwipeNavigation } from "@/hooks/useSwipeNavigation"
import { hapticLight } from "@/lib/haptics"
import { shortPath } from "@/lib/format"
import type { MobileAppShellProps } from "./mobileTypes"
import { adjacentMobileTab, visibleMobileTabs } from "./mobileView"
import {
  PrimarySessionBrowser,
  ProjectDashboard,
  SelectedTeamDashboard,
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
  const { session, sessionSource, isSubAgentView } = useSessionContext()

  const visibleTabs = useMemo(() => visibleMobileTabs({
    hasSession: Boolean(session),
    hasPendingSession: Boolean(state.pendingDirName),
    hasTeam: sessionView.hasTeam,
  }),
    [session, state.pendingDirName, sessionView.hasTeam],
  )
  const activeSessionKey = sessionSource
    ? `${sessionSource.dirName}/${sessionSource.fileName}`
    : null

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
    <div className={`${theme.themeClasses} flex h-dvh flex-col bg-elevation-0 text-foreground`}>
      {chrome.backgroundServers}
      <UpdateBanner />
      {!(state.mobileTab === "chat" && session && state.mainView !== "teams") && (
        <div className="flex h-10 shrink-0 items-center border-b border-border/40 bg-elevation-0 px-1.5">
          <DeviceSwitcher compact />
        </div>
      )}
      <main ref={swipeRef} className="flex flex-1 min-h-0 overflow-hidden">
        {state.mobileTab === "sessions" && (
          <PrimarySessionBrowser navigation={navigation} mobile />
        )}

        {state.mobileTab === "chat" && (
          <div className="flex flex-1 min-h-0 flex-col min-w-0">
            {state.mainView === "teams" && state.selectedTeam ? (
              <SelectedTeamDashboard navigation={navigation} />
            ) : session ? (
              <div className="flex flex-1 min-h-0 flex-col">
                {sessionView.teamMembersBar}
                {sessionView.agentContextBar}
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
                  <div className="flex-1 flex flex-col items-center justify-center gap-1">
                    <p className="text-sm text-muted-foreground">New session — type your first message below</p>
                    <p className="text-xs text-muted-foreground font-mono">{shortPath(sessionView.pendingPath ?? "")}</p>
                    <div className="flex items-center gap-1 mt-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 gap-1.5 text-[11px] text-muted-foreground hover:text-emerald-400 hover:bg-emerald-500/20"
                        onClick={project.onOpenTerminal}
                      >
                        <TerminalSquare className="size-3" />
                        Terminal
                      </Button>
                    </div>
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

        {state.mobileTab === "teams" && (
          <div className="flex flex-1 min-h-0 flex-col min-w-0">
            {state.selectedTeam ? (
              <SelectedTeamDashboard navigation={navigation} />
            ) : (
              <SessionBrowser
                sessionId={session?.sessionId ?? null}
                activeSessionKey={activeSessionKey}
                onLoadSession={navigation.actions.handleLoadSession}
                sidebarTab="teams"
                onSidebarTabChange={navigation.onSidebarTabChange}
                onSelectTeam={navigation.actions.handleSelectTeam}
                isMobile
                teamsOnly
                onBeforeSessionSwitch={navigation.onBeforeSessionSwitch}
                workerParse={navigation.workerParse}
              />
            )}
          </div>
        )}
      </main>

      {state.mobileTab === "chat" && chrome.processPanel}
      {chrome.workflowsPanel}
      {state.mobileTab === "chat" && (session || state.pendingDirName) && state.mainView !== "teams" && (
        <>
          {sessionView.todoProgress}
          {session ? sessionView.activeComposer : sessionView.pendingComposer}
        </>
      )}

      <MobileNav
        activeTab={state.mobileTab}
        onTabChange={changeTab}
        hasTeam={sessionView.hasTeam}
      />

      {chrome.undoDialog}
      {chrome.branchModal}
      {chrome.status}
      {session && (
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
