import { useState, useCallback, memo } from "react"
import {
  Search,
  ChevronsDownUp,
  ChevronsUpDown,
  Cpu,
  RotateCcw,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn, MODEL_OPTIONS } from "@/lib/utils"
import { SectionHeading } from "@/components/stats/SectionHeading"
import { InputOutputChart } from "@/components/stats/InputOutputChart"
import { ActivityHeatmap } from "@/components/stats/ActivityHeatmap"
import { ModelDistribution } from "@/components/stats/ModelDistribution"
import { ErrorLog } from "@/components/stats/ErrorLog"
import { BackgroundServers } from "@/components/stats/BackgroundServers"
import { AgentsPanel } from "@/components/stats/AgentsPanel"
import { TurnNavigator } from "@/components/stats/TurnNavigator"
import { ToolCallIndex } from "@/components/stats/ToolCallIndex"
import type { ParsedSession } from "@/lib/types"
import type { BgAgent } from "@/hooks/useBackgroundAgents"

// ── Props ──────────────────────────────────────────────────────────────────

interface StatsPanelProps {
  session: ParsedSession
  onJumpToTurn?: (turnIndex: number, toolCallId?: string) => void
  onToggleServer?: (id: string, outputPath: string, title: string) => void
  onServersChanged?: (servers: { id: string; outputPath: string; title: string }[]) => void
  /** When true, renders full-width mobile layout */
  isMobile?: boolean
  /** Search + expand controls (desktop only -- passed when sidebar hosts search) */
  searchQuery?: string
  onSearchChange?: (query: string) => void
  expandAll?: boolean
  onToggleExpandAll?: () => void
  searchInputRef?: React.RefObject<HTMLInputElement | null>
  /** Permissions panel props */
  permissionsPanel?: React.ReactNode
  /** Model selector */
  selectedModel?: string
  onModelChange?: (model: string) => void
  /** Whether model or permissions have pending changes requiring restart */
  hasSettingsChanges?: boolean
  /** Called when user confirms restarting the session to apply settings */
  onApplySettings?: () => Promise<void>
  /** Called when user clicks a background agent to open its session */
  onLoadSession?: (dirName: string, fileName: string) => void
  /** Current session source for detecting sub-agent view */
  sessionSource?: { dirName: string; fileName: string } | null
  /** Background agents from useBackgroundAgents (passed from App to avoid double-polling) */
  backgroundAgents?: BgAgent[]
}

// ── Search Header ──────────────────────────────────────────────────────────

interface SearchHeaderProps {
  searchQuery?: string
  onSearchChange: (query: string) => void
  expandAll?: boolean
  onToggleExpandAll?: () => void
  searchInputRef?: React.RefObject<HTMLInputElement | null>
}

function SearchHeader({
  searchQuery,
  onSearchChange,
  expandAll,
  onToggleExpandAll,
  searchInputRef,
}: SearchHeaderProps): JSX.Element {
  return (
    <div className="sticky top-0 z-10 border-b border-border/50 bg-elevation-1">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-medium text-foreground flex items-center gap-1.5">
          <Search className="size-3" />
          Session
        </span>
        {onToggleExpandAll && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 shrink-0"
            onClick={onToggleExpandAll}
            aria-label={expandAll ? "Collapse all" : "Expand all"}
          >
            {expandAll ? (
              <ChevronsDownUp className="size-3" />
            ) : (
              <ChevronsUpDown className="size-3" />
            )}
          </Button>
        )}
      </div>
      <div className="px-2 pb-2 pt-1">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery ?? ""}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search..."
            className="w-full rounded-lg border border-border/60 elevation-2 depth-low py-2 pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:border-blue-500/40 focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-colors"
          />
        </div>
      </div>
    </div>
  )
}

// ── Model Selector ─────────────────────────────────────────────────────────

interface ModelSelectorProps {
  selectedModel?: string
  onModelChange: (model: string) => void
}

function ModelSelector({ selectedModel, onModelChange }: ModelSelectorProps): JSX.Element {
  return (
    <div className="rounded-lg border border-border elevation-2 depth-low p-3">
      <section>
        <SectionHeading>
          <Cpu className="size-3" />
          Model
        </SectionHeading>
        <div className="grid grid-cols-2 gap-1">
          {MODEL_OPTIONS.map((opt) => {
            const isSelected = (selectedModel || "") === opt.value
            return (
              <button
                key={opt.value}
                onClick={() => onModelChange(opt.value)}
                className={cn(
                  "rounded-md border px-2 py-1.5 text-[10px] font-medium transition-colors",
                  isSelected
                    ? "border-blue-500 text-blue-400 bg-blue-500/10"
                    : "border-border text-muted-foreground hover:border-border hover:text-foreground elevation-1"
                )}
              >
                {opt.label}
              </button>
            )
          })}
        </div>
      </section>
    </div>
  )
}

// ── Restart Dialog ─────────────────────────────────────────────────────────

interface RestartDialogProps {
  open: boolean
  isRestarting: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

function RestartDialog({ open, isRestarting, onOpenChange, onConfirm }: RestartDialogProps): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !isRestarting) onOpenChange(o) }}>
      <DialogContent className="sm:max-w-md elevation-4 border-border/30">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-foreground">
            <RotateCcw className="size-4 text-amber-400" />
            Restart session?
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Applying new model or permission settings requires restarting the
            underlying Claude process. Your conversation history will be
            preserved, but the context cache will be cleared.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter className="gap-2">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={isRestarting}
            className="text-muted-foreground hover:text-foreground"
          >
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={isRestarting}
            className="bg-amber-600 hover:bg-amber-500 text-white"
          >
            {isRestarting ? "Restarting..." : "Apply & Restart"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────

export const StatsPanel = memo(function StatsPanel({
  session,
  onJumpToTurn,
  onToggleServer,
  onServersChanged,
  isMobile,
  searchQuery,
  onSearchChange,
  expandAll,
  onToggleExpandAll,
  searchInputRef,
  permissionsPanel,
  selectedModel,
  onModelChange,
  hasSettingsChanges,
  onApplySettings,
  onLoadSession,
  sessionSource,
  backgroundAgents,
}: StatsPanelProps) {
  const { turns } = session

  const [showRestartDialog, setShowRestartDialog] = useState(false)
  const [isRestarting, setIsRestarting] = useState(false)

  const handleConfirmRestart = useCallback(async () => {
    if (!onApplySettings) return
    setIsRestarting(true)
    try {
      await onApplySettings()
      setShowRestartDialog(false)
    } finally {
      setIsRestarting(false)
    }
  }, [onApplySettings])

  return (
    <aside className={cn(
      "shrink-0 min-h-0 h-full overflow-y-auto elevation-1",
      isMobile ? "w-full flex-1 mobile-scroll" : "w-[300px] border-l border-border panel-enter-right"
    )}>
      {onSearchChange && (
        <SearchHeader
          searchQuery={searchQuery}
          onSearchChange={onSearchChange}
          expandAll={expandAll}
          onToggleExpandAll={onToggleExpandAll}
          searchInputRef={searchInputRef}
        />
      )}

      <div className={cn("flex flex-col gap-6", isMobile ? "p-4" : "p-3")}>
        {permissionsPanel && (
          <div className="rounded-lg border border-border elevation-2 depth-low p-3">
            {permissionsPanel}
          </div>
        )}

        {onModelChange && (
          <ModelSelector selectedModel={selectedModel} onModelChange={onModelChange} />
        )}

        {hasSettingsChanges && onApplySettings && (
          <button
            onClick={() => setShowRestartDialog(true)}
            className="flex items-center justify-center gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-400 transition-colors hover:bg-amber-500/20 hover:border-amber-500/70"
          >
            <RotateCcw className="size-3" />
            Apply Changes
          </button>
        )}

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

      <RestartDialog
        open={showRestartDialog}
        isRestarting={isRestarting}
        onOpenChange={setShowRestartDialog}
        onConfirm={handleConfirmRestart}
      />
    </aside>
  )
})
