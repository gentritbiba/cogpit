import { useCallback, memo } from "react"
import { cn } from "@/lib/utils"
import { LiveSessions } from "@/components/LiveSessions"
import { ScriptsDock } from "@/components/ScriptsDock"
import { SessionTimeline } from "@/components/SessionTimeline"
import { CrossSessionSearch } from "@/components/search/CrossSessionSearch"
import type { SessionBrowserProps } from "./types"
import { BrowseTab } from "./BrowseTab"
import { useSessionBrowser } from "./useSessionBrowser"

// ── Tab type ───────────────────────────────────────────────────────────────

type SidebarTab = "live" | "browse" | "teams" | "timeline" | "search"

// ── Tab Bar ────────────────────────────────────────────────────────────────

function SidebarTabBar({
  activeTab,
  isMobile,
  onTabChange,
}: {
  activeTab: SidebarTab
  isMobile?: boolean
  onTabChange: (tab: SidebarTab) => void
}): React.ReactElement {
  const heightClass = isMobile ? "h-10" : "h-8"

  function tabClassName(isActive: boolean, extraClasses?: string): string {
    return cn(
      "flex-1 h-full text-xs font-medium transition-colors border-b-2",
      isActive
        ? "border-blue-500 text-foreground"
        : "border-transparent text-muted-foreground hover:text-muted-foreground",
      extraClasses,
    )
  }

  return (
    <div className={cn("flex shrink-0 border-b border-border/50", heightClass)} role="tablist">
      <button
        role="tab"
        aria-selected={activeTab === "live"}
        onClick={() => onTabChange("live")}
        className={tabClassName(activeTab === "live", "flex items-center justify-center")}
      >
        Live
      </button>
      <button
        role="tab"
        aria-selected={activeTab === "browse"}
        onClick={() => onTabChange("browse")}
        className={tabClassName(activeTab === "browse", "flex items-center justify-center")}
      >
        Browse
      </button>
      <button
        role="tab"
        aria-selected={activeTab === "timeline"}
        onClick={() => onTabChange("timeline")}
        className={tabClassName(activeTab === "timeline", "flex items-center justify-center")}
      >
        Timeline
      </button>
      <button
        role="tab"
        aria-selected={activeTab === "search"}
        onClick={() => onTabChange("search")}
        className={tabClassName(activeTab === "search", "flex items-center justify-center")}
      >
        Search
      </button>
    </div>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────

export const SessionBrowser = memo(function SessionBrowser({
  sessionId,
  activeSessionKey,
  onLoadSession,
  sidebarTab,
  onSidebarTabChange,
  onSelectTeam,
  onNewSession,
  creatingSession,
  isMobile,
  teamsOnly,
  onDuplicateSession,
  onDeleteSession,
  onBeforeSessionSwitch,
  pendingSession,
  liveSessionsRefreshRef,
  projectDir,
  onScriptStarted,
}: SessionBrowserProps): React.ReactElement {
  const browser = useSessionBrowser({
    sessionId,
    onLoadSession,
    onDeleteSession,
    onDuplicateSession,
    onBeforeLoad: onBeforeSessionSwitch,
  })

  const { view, selectedProject, loadProjects, loadSessions, setFetchError } = browser
  const handleRetry = useCallback(() => {
    if (view === "projects") {
      loadProjects()
    } else if (view === "sessions" && selectedProject) {
      loadSessions(selectedProject)
    }
  }, [view, selectedProject, loadProjects, loadSessions])

  const handleClearError = useCallback(() => {
    setFetchError(null)
  }, [setFetchError])

  // Mobile teams-only mode: just show the teams list
  if (teamsOnly) {
    return (
      <div className="flex h-full w-full flex-col elevation-1">
        <TeamsList onSelectTeam={(teamName) => onSelectTeam?.(teamName)} />
      </div>
    )
  }

  return (
    <aside
      className={cn(
        "flex h-full shrink-0 flex-col elevation-1",
        isMobile ? "w-full" : "w-80 panel-enter"
      )}
      aria-label="Session browser"
    >
      <SidebarTabBar
        activeTab={sidebarTab}
        isMobile={isMobile}
        onTabChange={onSidebarTabChange}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {sidebarTab === "live" && (
          <LiveSessions
            activeSessionKey={activeSessionKey}
            onSelectSession={browser.loadLiveSession}
            onDuplicateSession={onDuplicateSession}
            onDeleteSession={onDeleteSession}
            onNewSession={onNewSession}
            creatingSession={creatingSession}
            pendingSession={pendingSession}
            refreshRef={liveSessionsRefreshRef}
          />
        )}

        {sidebarTab === "browse" && (
          <BrowseTab
            view={browser.view}
            selectedProject={browser.selectedProject}
            projects={browser.projects}
            sessions={browser.sessions}
            sessionsTotal={browser.sessionsTotal}
            isLoading={browser.isLoading}
            fetchError={browser.fetchError}
            searchFilter={browser.searchFilter}
            isMobile={isMobile}
            creatingSession={creatingSession}
            onSearchFilterChange={browser.setSearchFilter}
            onBack={browser.handleBack}
            onRefreshProjects={browser.loadProjects}
            onSelectProject={browser.loadSessions}
            onSelectSession={browser.handleSelectSession}
            onDuplicateSession={onDuplicateSession ? browser.handleDuplicateSession : undefined}
            onDeleteSession={onDeleteSession ? browser.handleDeleteSession : undefined}
            onNewSession={onNewSession}
            onLoadMoreSessions={browser.handleLoadMoreSessions}
            onRetry={handleRetry}
            onClearError={handleClearError}
          />
        )}

        {sidebarTab === "timeline" && (
          <div className="flex-1 min-h-0">
            <SessionTimeline />
          </div>
        )}

        {sidebarTab === "search" && (
          <div className="flex-1 min-h-0">
            <CrossSessionSearch
              onOpenSession={(dirName, sessionId) => {
                browser.loadLiveSession(dirName, `${sessionId}.jsonl`)
              }}
            />
          </div>
        )}
      </div>

      {/* Scripts dock — always visible at bottom */}
      {!isMobile && (
        <ScriptsDock
          projectDir={projectDir}
          onScriptStarted={onScriptStarted}
        />
      )}
    </aside>
  )
})
