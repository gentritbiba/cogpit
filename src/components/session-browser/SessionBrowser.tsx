import { useCallback, memo } from "react"
import { Users } from "lucide-react"
import { cn } from "@/lib/utils"
import { LiveSessions } from "@/components/LiveSessions"
import { TeamsList } from "@/components/TeamsList"
import type { SessionBrowserProps } from "./types"
import { BrowseTab } from "./BrowseTab"
import { useSessionBrowser } from "./useSessionBrowser"

// ── Tab Bar ────────────────────────────────────────────────────────────────

function SidebarTabBar({
  activeTab,
  isMobile,
  onTabChange,
}: {
  activeTab: "browse" | "teams"
  isMobile?: boolean
  onTabChange: (tab: "browse" | "teams") => void
}): React.ReactElement {
  const paddingClass = isMobile ? "py-3" : "py-2"

  function tabClassName(isActive: boolean, extraClasses?: string): string {
    return cn(
      "flex-1 text-xs font-medium transition-colors border-b-2",
      paddingClass,
      isActive
        ? "border-blue-500 text-foreground"
        : "border-transparent text-muted-foreground hover:text-muted-foreground",
      extraClasses,
    )
  }

  return (
    <div className="flex shrink-0 border-b border-border/50" role="tablist">
      <button
        role="tab"
        aria-selected={activeTab === "browse"}
        onClick={() => onTabChange("browse")}
        className={tabClassName(activeTab === "browse")}
      >
        Browse
      </button>
      <button
        role="tab"
        aria-selected={activeTab === "teams"}
        onClick={() => onTabChange("teams")}
        className={tabClassName(activeTab === "teams", "flex items-center justify-center gap-1.5")}
      >
        <Users className="size-3" />
        Teams
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
}: SessionBrowserProps): React.ReactElement {
  const browser = useSessionBrowser({
    sessionId,
    onLoadSession,
    onDeleteSession,
    onDuplicateSession,
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
        isMobile ? "w-full" : "w-80 border-r border-border/50 panel-enter"
      )}
      aria-label="Session browser"
    >
      {/* Top: Live Sessions */}
      <div className="flex min-h-0 flex-[55_1_0%] flex-col overflow-hidden">
        <LiveSessions
          activeSessionKey={activeSessionKey}
          onSelectSession={browser.loadLiveSession}
          onDuplicateSession={onDuplicateSession}
          onDeleteSession={onDeleteSession}
        />
      </div>

      {/* Bottom: Browse / Teams */}
      <div className="flex min-h-0 flex-[45_1_0%] flex-col overflow-hidden border-t border-border/50">
        <SidebarTabBar
          activeTab={sidebarTab}
          isMobile={isMobile}
          onTabChange={onSidebarTabChange}
        />

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

        {sidebarTab === "teams" && (
          <div className="flex-1 min-h-0">
            <TeamsList onSelectTeam={(teamName) => onSelectTeam?.(teamName)} />
          </div>
        )}
      </div>
    </aside>
  )
})
