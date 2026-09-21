import { lazy, Suspense, useState } from "react"
import { TerminalSquare } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ChatArea } from "@/components/ChatArea"
import { DeviceSwitcher } from "@/components/DeviceSwitcher"
import { MobileNav, type MobileTab } from "@/components/MobileNav"
import { SessionInfoBar } from "@/components/SessionInfoBar"
import { ProviderUpdateBanner } from "@/components/ProviderUpdateBanner"
import { UpdateBanner } from "@/components/UpdateBanner"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext } from "@/contexts/SessionContext"
import { useSwipeNavigation } from "@/hooks/useSwipeNavigation"
import { can } from "@/lib/capabilities"
import { hapticLight } from "@/lib/haptics"
import { cn } from "@/lib/utils"
import type { MobileAppShellProps } from "./mobileTypes"
import { adjacentMobileTab, MOBILE_TAB_ORDER } from "./mobileView"
import { MobileWorkspace } from "./MobileWorkspace"
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
  const { session } = useSessionContext()
  const [searchOpen, setSearchOpen] = useState(false)

  const swipeRef = useSwipeNavigation<HTMLElement>({
    onSwipeLeft: () => {
      if (state.mobileTab === "workspace") return
      const nextTab = adjacentMobileTab(MOBILE_TAB_ORDER, state.mobileTab, 1)
      if (nextTab) {
        hapticLight()
        navigation.actions.handleMobileTabChange(nextTab)
      }
    },
    onSwipeRight: () => {
      if (state.mobileTab === "workspace") return
      const nextTab = adjacentMobileTab(MOBILE_TAB_ORDER, state.mobileTab, -1)
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
    <div className="flex h-dvh flex-col bg-canvas text-foreground">
      {chrome.backgroundServers}
      <UpdateBanner />
      <ProviderUpdateBanner />
      {!(state.mobileTab === "chat" && session) && (
        <div className="motion-slide-down-in flex h-12 shrink-0 items-center border-b bg-background px-2">
          <DeviceSwitcher compact />
        </div>
      )}
      <main ref={swipeRef} className="app-view-transition relative flex flex-1 min-h-0 overflow-hidden">
        {state.mobileTab === "sessions" && (
          <PrimarySessionBrowser navigation={navigation} mobile />
        )}

        <div
          aria-hidden={state.mobileTab !== "chat"}
          inert={state.mobileTab !== "chat"}
          className={cn("absolute inset-0 flex min-h-0 min-w-0 flex-col", state.mobileTab !== "chat" && "invisible pointer-events-none")}
        >
          <MobileChat
            navigation={navigation}
            sessionView={sessionView}
            project={project}
            chrome={chrome}
            searchOpen={searchOpen}
            onSearchOpenChange={setSearchOpen}
          />
        </div>

        <div
          aria-hidden={state.mobileTab !== "workspace"}
          inert={state.mobileTab !== "workspace"}
          className={cn("absolute inset-0 flex min-h-0 min-w-0 flex-col", state.mobileTab !== "workspace" && "hidden")}
        >
          <MobileWorkspace navigation={navigation} sessionView={sessionView} project={project} chrome={chrome} active={state.mobileTab === "workspace"} />
        </div>
      </main>

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

function MobileChat({
  navigation, sessionView, project, chrome, searchOpen, onSearchOpenChange,
}: MobileAppShellProps & { searchOpen: boolean; onSearchOpenChange: (open: boolean) => void }) {
  const { state, config } = useAppContext()
  const { session, isSubAgentView } = useSessionContext()

  return (
    <>
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
            onSearch={() => onSearchOpenChange(true)}
            expandAll={state.expandAll}
            onToggleExpandAll={sessionView.onToggleExpandAll}
          />
          <ChatArea
            searchInputRef={sessionView.searchInputRef}
            hasMore={sessionView.hasMoreTurns}
            isLoadingOlder={sessionView.isLoadingOlderTurns}
            onLoadMore={sessionView.onLoadMoreTurns}
            mobileSearchOpen={searchOpen}
            onMobileSearchClose={() => onSearchOpenChange(false)}
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
              <NewSessionHeadline
                projectPath={sessionView.pendingPath ?? null}
                switcher={{
                  onNewSession: navigation.onStartNewSession,
                  onNewFolder: navigation.onStartNewFolder,
                  defaultAgentKind: config.defaultAgentKind,
                }}
              />
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
      <div className="shrink-0">
        {chrome.processPanel}
        {(session || state.pendingDirName) && (
          <>
            {sessionView.todoProgress}
            {session ? sessionView.activeComposer : sessionView.pendingComposer}
          </>
        )}
      </div>
    </>
  )
}
