import { lazy, Suspense, useMemo, useState } from "react"
import { TerminalSquare } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ChatArea } from "@/components/ChatArea"
import { DeviceSwitcher } from "@/components/DeviceSwitcher"
import { MobileNav, type MobileTab } from "@/components/MobileNav"
import { SessionInfoBar } from "@/components/SessionInfoBar"
import { StatsPanel } from "@/components/StatsPanel"
import { ProviderUpdateBanner } from "@/components/ProviderUpdateBanner"
import { UpdateBanner } from "@/components/UpdateBanner"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext } from "@/contexts/SessionContext"
import { useSwipeNavigation } from "@/hooks/useSwipeNavigation"
import { can } from "@/lib/capabilities"
import { hapticLight } from "@/lib/haptics"
import { cn } from "@/lib/utils"
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
  const { state } = useAppContext()
  const { session, isSubAgentView } = useSessionContext()
  const [searchOpen, setSearchOpen] = useState(false)

  const visibleTabs = useMemo(() => visibleMobileTabs({
    hasSession: Boolean(session),
    hasPendingSession: Boolean(state.pendingDirName),
  }),
    [session, state.pendingDirName],
  )

  const swipeRef = useSwipeNavigation<HTMLElement>({
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
    setSearchOpen(false)
    navigation.actions.handleMobileTabChange(tab)
  }

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      {chrome.backgroundServers}
      <UpdateBanner />
      <ProviderUpdateBanner />
      {!(state.mobileTab === "chat" && session) && (
        <div className="motion-slide-down-in flex h-12 shrink-0 items-center border-b bg-background px-2">
          <DeviceSwitcher compact />
        </div>
      )}
      <main ref={swipeRef} className="app-view-transition flex flex-1 min-h-0 overflow-hidden">
        <div
          key={state.mobileTab}
          className={cn(
            "flex min-h-0 min-w-0 flex-1",
            !(state.mobileTab === "chat" && session) && "motion-session-enter",
          )}
        >
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
                    onBackToMain={isSubAgentView ? sessionView.onBackToMain : undefined}
                    onShowFileChanges={() => chrome.onFileChangesOpenChange(true)}
                    hasFileChanges={project.hasFileChanges}
                    onShowWorkflows={sessionView.onShowWorkflows}
                    workflowCount={sessionView.workflowCount}
                    onSearch={() => setSearchOpen(true)}
                    expandAll={state.expandAll}
                    onToggleExpandAll={sessionView.onToggleExpandAll}
                  />
                  <ChatArea
                    searchInputRef={sessionView.searchInputRef}
                    hasMore={sessionView.hasMoreTurns}
                    isLoadingOlder={sessionView.isLoadingOlderTurns}
                    onLoadMore={sessionView.onLoadMoreTurns}
                    mobileSearchOpen={searchOpen}
                    onMobileSearchClose={() => setSearchOpen(false)}
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
        </div>
      </main>

      <div className="shrink-0">
        {state.mobileTab === "chat" && chrome.processPanel}
        {state.mobileTab === "chat" && (session || state.pendingDirName) && (
          <>
            {sessionView.todoProgress}
            {session ? sessionView.activeComposer : sessionView.pendingComposer}
          </>
        )}
      </div>

      {chrome.workflowsPanel}

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
