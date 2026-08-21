import { memo, useMemo, useState } from "react"
import type { LucideIcon } from "lucide-react"
import {
  Activity,
  ChartColumn,
  Check,
  ChevronRight,
  FileCode2,
  GitBranch,
  Globe,
  LayoutGrid,
  MoreHorizontal,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Settings,
  Skull,
  SlidersHorizontal,
  Workflow as WorkflowIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { DeviceSwitcher } from "@/components/DeviceSwitcher"
import { LeakIndicator } from "@/components/LeakIndicator"
import { NotificationsBell } from "@/components/NotificationsBell"
import { PowerMonitor } from "@/components/PowerMonitor"
import { SessionPill } from "@/components/SessionPill"
import { TokenUsageIndicator } from "@/components/TokenUsageWidget"
import { UsageCostDialog } from "@/components/UsageCostDialog"
import { FLOATING_PILL } from "@/components/header-shared"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext } from "@/contexts/SessionContext"
import { useSessionInventoryOptional } from "@/contexts/SessionInventoryContext"
import { useCapability } from "@/hooks/useCapability"
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback"
import { can } from "@/lib/capabilities"
import { parseSubAgentPath } from "@/lib/format"
import { agentKindFromDirName, getResumeCommand } from "@/lib/sessionSource"
import { cn, copyToClipboard } from "@/lib/utils"
import { extractPullRequests, mergePullRequests } from "../../shared/session/prLinks"

interface FloatingChromeProps {
  /** Whether the sidebar is toggled on — decides if the expand pill is offered. */
  showSidebar: boolean
  /**
   * Whether a sidebar is actually on screen. Config view replaces it with its
   * own rail, and without a sidebar the pills have to clear the traffic lights
   * themselves.
   */
  sidebarRendered?: boolean
  sidebarShortcut: string
  showStats: boolean
  showWorktrees?: boolean
  showFileChanges?: boolean
  hasFileChanges?: boolean
  killing: boolean
  creatingSession: boolean
  onNewSession: (dirName: string, cwd?: string) => void
  onDuplicateSession?: () => void
  onOpenTerminal?: () => void
  onBackToMain?: () => void
  onShowWorkflows?: () => void
  workflowCount?: number
  onToggleSidebar: () => void
  onToggleStats: () => void
  onToggleWorktrees?: () => void
  onToggleFileChanges?: () => void
  onKillAll: () => void
  onOpenSettings: () => void
  showConfig?: boolean
  onToggleConfig?: () => void
  showMission?: boolean
  onToggleMission?: () => void
}

const PILL_ROW = "flex h-8 items-center px-0.5"

/**
 * Everything that used to live in the top bar, floating over the chat pane:
 * session pill on the left, status pills and the overflow menu on the right.
 * Content scrolls underneath; the pane reserves its own top padding.
 */
export const FloatingChrome = memo(function FloatingChrome({
  showSidebar,
  sidebarRendered = showSidebar,
  sidebarShortcut,
  showStats,
  showWorktrees,
  showFileChanges,
  hasFileChanges,
  killing,
  creatingSession,
  onNewSession,
  onDuplicateSession,
  onOpenTerminal,
  onBackToMain,
  onShowWorkflows,
  workflowCount,
  onToggleSidebar,
  onToggleStats,
  onToggleWorktrees,
  onToggleFileChanges,
  onKillAll,
  onOpenSettings,
  showConfig,
  onToggleConfig,
  showMission,
  onToggleMission,
}: FloatingChromeProps) {
  const { config: { networkUrl, defaultAgentKind } } = useAppContext()
  const { session, sessionSource, isLive } = useSessionContext()
  const inventory = useSessionInventoryOptional()
  const canViewUsage = useCapability("viewUsage")
  const [usageOpen, setUsageOpen] = useState(false)
  const [monitorOpen, setMonitorOpen] = useState(false)
  const [cmdCopied, copyCmd] = useCopyWithFeedback()

  const sessionTurns = session?.turns
  const scanned = inventory?.sessions.find(
    (candidate) => candidate.sessionId === session?.sessionId,
  )?.pullRequests
  const pullRequests = useMemo(
    () => mergePullRequests(extractPullRequests(sessionTurns ?? []), scanned),
    [sessionTurns, scanned],
  )
  const activeAgentKind = sessionSource
    ? sessionSource.agentKind ?? agentKindFromDirName(sessionSource.dirName)
    : defaultAgentKind
  const isSubAgent = sessionSource ? parseSubAgentPath(sessionSource.fileName) !== null : false

  function handleCopyResumeCmd(): void {
    if (!session) return
    const agentKind = sessionSource?.agentKind ?? agentKindFromDirName(sessionSource?.dirName ?? null)
    copyCmd(getResumeCommand(agentKind, session.sessionId, session.cwd))
  }

  function handleCopyNetworkUrl(): void {
    if (!networkUrl) return
    void copyToClipboard(networkUrl).then((ok) => {
      if (ok) toast.success("Copied network URL")
    })
  }

  return (
    <>
      {/* Content scrolls under the pills, so it has to fade out rather than
          collide with them. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 z-20 h-16 bg-gradient-to-b from-background from-50% to-transparent"
      />
      <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex items-start justify-between gap-3 px-3 pt-2">
        <div
          className={cn(
            "electron-no-drag pointer-events-auto flex min-w-0 items-center gap-1.5",
            !sidebarRendered && "window-inset-start",
          )}
        >
          {!showSidebar && (
            <PillIconButton
              icon={PanelLeftOpen}
              label={`Show sidebar (${sidebarShortcut})`}
              onClick={onToggleSidebar}
            />
          )}

          {session && isSubAgent && onBackToMain && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={onBackToMain}
              className={cn(FLOATING_PILL, "h-8 shrink-0 px-2.5 text-xs text-muted-foreground")}
            >
              <ChevronRight className="size-3 rotate-180" />
              Main
            </Button>
          )}

          {session && (
            <SessionPill
              session={session}
              sessionSource={sessionSource}
              isLive={isLive}
              pullRequests={pullRequests}
              copied={cmdCopied}
              creatingSession={creatingSession}
              onCopyResume={handleCopyResumeCmd}
              onNewSession={onNewSession}
              onDuplicateSession={onDuplicateSession}
              onOpenTerminal={onOpenTerminal}
            />
          )}

          {session && onShowWorkflows && (workflowCount ?? 0) > 0 && (
            <Button
              variant="ghost"
              size="xs"
              className={cn(
                FLOATING_PILL,
                "h-8 shrink-0 gap-1 px-2.5 text-[11px] text-muted-foreground hover:text-foreground",
              )}
              onClick={onShowWorkflows}
            >
              <WorkflowIcon className="size-3" />
              Workflows
              <Badge variant="outline" className="h-4 min-w-4 justify-center px-1 text-[9px] font-semibold">
                {workflowCount}
              </Badge>
            </Button>
          )}
        </div>

        <div className="electron-no-drag window-inset-end pointer-events-auto flex shrink-0 items-center gap-1.5">
          <div className={cn(FLOATING_PILL, PILL_ROW, "empty:hidden")}>
            <LeakIndicator />
          </div>
          <div className={cn(FLOATING_PILL, PILL_ROW, "empty:hidden")}>
            <NotificationsBell />
          </div>
          <div className={cn(FLOATING_PILL, PILL_ROW, "empty:hidden")}>
            <TokenUsageIndicator agentKind={activeAgentKind} />
          </div>
          <div className={cn(FLOATING_PILL, PILL_ROW, "empty:hidden")}>
            <DeviceSwitcher />
          </div>

          <div className={cn(FLOATING_PILL, PILL_ROW)}>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon-sm" aria-label="More actions" />}
              >
                <MoreHorizontal data-icon="inline-start" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={6} className="w-64">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Workspace</DropdownMenuLabel>
                  {onToggleMission && (
                    <DropdownMenuItem onClick={onToggleMission}>
                      <LayoutGrid />
                      Mission Control
                      {showMission && <Check className="ml-auto" />}
                    </DropdownMenuItem>
                  )}
                  {onToggleConfig && (
                    <DropdownMenuItem onClick={onToggleConfig}>
                      <SlidersHorizontal />
                      Config
                      {showConfig && <Check className="ml-auto" />}
                    </DropdownMenuItem>
                  )}
                  {onToggleWorktrees && (
                    <DropdownMenuItem onClick={onToggleWorktrees}>
                      <GitBranch />
                      Worktrees
                      {showWorktrees && <Check className="ml-auto" />}
                    </DropdownMenuItem>
                  )}
                  {hasFileChanges && onToggleFileChanges && (
                    <DropdownMenuItem onClick={onToggleFileChanges}>
                      <FileCode2 />
                      File changes
                      {showFileChanges && <Check className="ml-auto" />}
                    </DropdownMenuItem>
                  )}
                  {session && (
                    <DropdownMenuItem onClick={onToggleStats}>
                      {showStats ? <PanelRightClose /> : <PanelRightOpen />}
                      Session details
                      {showStats && <Check className="ml-auto" />}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  {canViewUsage && (
                    <DropdownMenuItem onClick={() => setUsageOpen(true)}>
                      <ChartColumn />
                      Usage &amp; cost…
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={() => setMonitorOpen(true)}>
                    <Activity />
                    Server monitor…
                  </DropdownMenuItem>
                  {networkUrl && (
                    <DropdownMenuItem onClick={handleCopyNetworkUrl}>
                      <Globe className="text-success" />
                      Copy network URL
                      <span className="ml-auto truncate pl-2 font-mono text-[11px] text-muted-foreground">
                        {networkUrl}
                      </span>
                    </DropdownMenuItem>
                  )}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem onClick={onOpenSettings}>
                    <Settings />
                    Settings
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                {can("killAny") && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={onKillAll}
                        disabled={killing}
                      >
                        <Skull />
                        {killing ? "Stopping processes…" : "Stop all agent processes"}
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {canViewUsage && <UsageCostDialog open={usageOpen} onOpenChange={setUsageOpen} />}
      <PowerMonitor open={monitorOpen} onOpenChange={setMonitorOpen} />
    </>
  )
})

interface PillIconButtonProps {
  icon: LucideIcon
  label: string
  onClick: () => void
}

function PillIconButton({ icon: Icon, label, onClick }: PillIconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClick}
            aria-label={label}
            className={cn(FLOATING_PILL, "size-8 shrink-0")}
          />
        }
      >
        <Icon data-icon="inline-start" />
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}
