import { memo } from "react"
import {
  Search,
  ChevronsDownUp,
  ChevronsUpDown,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import { InputOutputChart } from "@/components/stats/InputOutputChart"
import { ActivityHeatmap } from "@/components/stats/ActivityHeatmap"
import { ModelDistribution } from "@/components/stats/ModelDistribution"
import { AttributionPanel } from "@/components/stats/AttributionPanel"
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
  embedded?: boolean
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

function SearchHeader({ searchInputRef }: SearchHeaderProps): React.JSX.Element {
  const { state: { searchQuery, expandAll }, dispatch } = useAppContext()
  const { actions: { handleToggleExpandAll } } = useSessionContext()
  return (
    <div className="sticky top-0 border-b bg-background px-3 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">Session details</span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          onClick={handleToggleExpandAll}
          aria-label={expandAll ? "Collapse all" : "Expand all"}
        >
          {expandAll ? (
            <ChevronsDownUp data-icon="inline-start" />
          ) : (
            <ChevronsUpDown data-icon="inline-start" />
          )}
        </Button>
      </div>
      <InputGroup>
        <InputGroupInput
          ref={searchInputRef}
          type="text"
          value={searchQuery ?? ""}
          onChange={(e) => dispatch({ type: "SET_SEARCH_QUERY", value: e.target.value })}
          placeholder="Search conversation"
          aria-label="Search conversation"
        />
        <InputGroupAddon align="inline-start">
          <Search />
        </InputGroupAddon>
      </InputGroup>
    </div>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────

export const StatsPanel = memo(function StatsPanel({
  embedded = false,
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
      "h-full min-h-0 shrink-0 overflow-y-auto bg-background",
      isMobile
        ? "mobile-scroll w-full flex-1"
        : embedded
          ? "w-full"
          : "view-transition-right-panel panel-enter-right w-[320px] border-l",
    )}>
      {searchInputRef && (
        <SearchHeader
          searchInputRef={searchInputRef}
        />
      )}

      <Tabs defaultValue="activity" className={cn(isMobile ? "p-4" : "p-3")}>
        <TabsList variant="line" className="grid w-full grid-cols-4">
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="agents">Agents</TabsTrigger>
          <TabsTrigger value="metrics">Metrics</TabsTrigger>
          <TabsTrigger value="issues">Issues</TabsTrigger>
        </TabsList>
        <TabsContent value="activity" className="flex flex-col gap-6 pt-3">
          <TurnNavigator turns={turns} onJumpToTurn={onJumpToTurn} />
          <ToolCallIndex turns={turns} onJumpToTurn={onJumpToTurn} />
        </TabsContent>
        <TabsContent value="agents" className="flex flex-col gap-6 pt-3">
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
        </TabsContent>
        <TabsContent value="metrics" className="flex flex-col gap-6 pt-3">
          <InputOutputChart turns={turns} />
          <ActivityHeatmap turns={turns} />
          <ModelDistribution turns={turns} />
          <AttributionPanel turns={turns} />
        </TabsContent>
        <TabsContent value="issues" className="flex flex-col gap-6 pt-3">
          <ErrorLog turns={turns} onJumpToTurn={onJumpToTurn} />
        </TabsContent>
      </Tabs>
    </aside>
  )
})
