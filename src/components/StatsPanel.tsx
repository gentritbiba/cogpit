import { memo } from "react"
import {
  Search,
  ChevronsDownUp,
  ChevronsUpDown,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { InputOutputChart } from "@/components/stats/InputOutputChart"
import { ActivityHeatmap } from "@/components/stats/ActivityHeatmap"
import { ModelDistribution } from "@/components/stats/ModelDistribution"
import { ErrorLog } from "@/components/stats/ErrorLog"
import { BackgroundServers } from "@/components/stats/BackgroundServers"
import { AgentsPanel } from "@/components/stats/AgentsPanel"
import { TurnNavigator } from "@/components/stats/TurnNavigator"
import { ToolCallIndex } from "@/components/stats/ToolCallIndex"
import type { BgAgent } from "@/hooks/useBackgroundAgents"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext } from "@/contexts/SessionContext"

// ── Props ──────────────────────────────────────────────────────────────────

interface StatsPanelProps {
  onJumpToTurn?: (turnIndex: number, toolCallId?: string) => void
  onToggleServer?: (id: string, outputPath: string, title: string) => void
  onServersChanged?: (servers: { id: string; outputPath: string; title: string }[]) => void
  searchInputRef?: React.RefObject<HTMLInputElement | null>
  /** Called when user clicks a background agent to open its session */
  onLoadSession?: (dirName: string, fileName: string) => void
  /** Background agents from useBackgroundAgents (passed from App to avoid double-polling) */
  backgroundAgents?: BgAgent[]
}

// ── Search Header ──────────────────────────────────────────────────────────

interface SearchHeaderProps {
  searchInputRef?: React.RefObject<HTMLInputElement | null>
}

function SearchHeader({ searchInputRef }: SearchHeaderProps): JSX.Element {
  const { state: { searchQuery, expandAll }, dispatch } = useAppContext()
  const { actions: { handleToggleExpandAll } } = useSessionContext()
  return (
    <div className="sticky top-0 z-10 border-b border-border/50 bg-elevation-1">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-medium text-foreground flex items-center gap-1.5">
          <Search className="size-3" />
          Session
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 shrink-0"
          onClick={handleToggleExpandAll}
          aria-label={expandAll ? "Collapse all" : "Expand all"}
        >
          {expandAll ? (
            <ChevronsDownUp className="size-3" />
          ) : (
            <ChevronsUpDown className="size-3" />
          )}
        </Button>
      </div>
      <div className="px-2 pb-2 pt-1">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery ?? ""}
            onChange={(e) => dispatch({ type: "SET_SEARCH_QUERY", value: e.target.value })}
            placeholder="Search..."
            className="w-full rounded-lg border border-border/60 elevation-2 depth-low py-2 pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:border-blue-500/40 focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-colors"
          />
        </div>
      </div>
    </div>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────

export const StatsPanel = memo(function StatsPanel({
  onJumpToTurn,
  onToggleServer,
  onServersChanged,
  searchInputRef,
  onLoadSession,
  backgroundAgents,
}: StatsPanelProps) {
  const { isMobile } = useAppContext()
  const { session: sessionOrNull, sessionSource } = useSessionContext()
  const session = sessionOrNull!
  const { turns } = session

  return (
    <aside className={cn(
      "shrink-0 min-h-0 h-full overflow-y-auto elevation-1",
      isMobile ? "w-full flex-1 mobile-scroll" : "w-[300px] border-l border-border panel-enter-right"
    )}>
      {searchInputRef && (
        <SearchHeader
          searchInputRef={searchInputRef}
        />
      )}

      <div className={cn("flex flex-col gap-6", isMobile ? "p-4" : "p-3")}>
        <BackgroundServers
          cwd={session.cwd}
          turns={turns}
          onToggleServer={onToggleServer}
          onServersChanged={onServersChanged}
        />

        <AgentsPanel
          session={session}
          sessionSource={sessionSource}
          bgAgents={backgroundAgents ?? []}
          onLoadSession={onLoadSession}
        />

        <TurnNavigator turns={turns} onJumpToTurn={onJumpToTurn} />
        <ToolCallIndex turns={turns} onJumpToTurn={onJumpToTurn} />
        <InputOutputChart turns={turns} />
        <ActivityHeatmap turns={turns} />
        <ModelDistribution turns={turns} />
        <ErrorLog turns={turns} onJumpToTurn={onJumpToTurn} />
      </div>
    </aside>
  )
})
