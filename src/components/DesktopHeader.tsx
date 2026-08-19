import { memo } from "react"
import {
  Eye,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Check,
  Skull,
  Settings,
  Globe,
  GitBranch,
  SlidersHorizontal,
  FileCode2,
  Search,
  MoreHorizontal,
  LayoutGrid,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
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
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip"
import { TokenUsageIndicator } from "@/components/TokenUsageWidget"
import { LeakIndicator } from "@/components/LeakIndicator"
import { NotificationsBell } from "@/components/NotificationsBell"
import { PowerMonitor } from "@/components/PowerMonitor"
import { LiveIndicator, HeaderIconButton } from "@/components/header-shared"
import { DeviceSwitcher } from "@/components/DeviceSwitcher"
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback"
import { can } from "@/lib/capabilities"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext } from "@/contexts/SessionContext"
import { projectName } from "@/lib/format"
import { agentKindFromDirName, getResumeCommand } from "@/lib/sessionSource"

interface DesktopHeaderProps {
  showSidebar: boolean
  showStats: boolean
  showWorktrees?: boolean
  showFileChanges?: boolean
  hasFileChanges?: boolean
  killing: boolean
  onGoHome: () => void
  onToggleSidebar: () => void
  onToggleStats: () => void
  onToggleWorktrees?: () => void
  onToggleFileChanges?: () => void
  onKillAll: () => void
  onOpenSettings: () => void
  onOpenCommandPalette: () => void
  commandPaletteShortcut: string
  showConfig?: boolean
  onToggleConfig?: () => void
  showMission?: boolean
  onToggleMission?: () => void
}

export const DesktopHeader = memo(function DesktopHeader({
  showSidebar,
  showStats,
  showWorktrees,
  showFileChanges,
  hasFileChanges,
  killing,
  onGoHome,
  onToggleSidebar,
  onToggleStats,
  onToggleWorktrees,
  onToggleFileChanges,
  onKillAll,
  onOpenSettings,
  onOpenCommandPalette,
  commandPaletteShortcut,
  showConfig,
  onToggleConfig,
  showMission,
  onToggleMission,
}: DesktopHeaderProps) {
  const { config: { networkUrl, defaultAgentKind } } = useAppContext()
  const { session, sessionSource, isLive } = useSessionContext()
  const activeAgentKind = sessionSource
    ? sessionSource.agentKind ?? agentKindFromDirName(sessionSource.dirName)
    : defaultAgentKind
  const [cmdCopied, copyCmd] = useCopyWithFeedback()
  const [urlCopied, copyUrl] = useCopyWithFeedback()

  function handleCopyResumeCmd(): void {
    if (!session) return
    const agentKind = sessionSource?.agentKind ?? agentKindFromDirName(sessionSource?.dirName ?? null)
    copyCmd(getResumeCommand(agentKind, session.sessionId, session.cwd))
  }

  function handleCopyNetworkUrl(): void {
    if (!networkUrl) return
    copyUrl(networkUrl)
  }

  const sessionLabel = session?.slug || session?.sessionId.slice(0, 8)
  const projectLabel = session?.cwd ? projectName(session.cwd) : null

  return (
    <header className="electron-drag flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3">
      <HeaderIconButton
        icon={showSidebar ? PanelLeftClose : PanelLeftOpen}
        label={showSidebar ? "Hide sidebar (Ctrl+B)" : "Show sidebar (Ctrl+B)"}
        onClick={onToggleSidebar}
        size="default"
      />

      <div className="flex min-w-0 items-center gap-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={onGoHome}
                aria-label={session ? "Back to dashboard" : "Cogpit"}
              />
            }
          >
              <Eye data-icon="inline-start" />
          </TooltipTrigger>
          <TooltipContent>{session ? "Back to dashboard" : "Cogpit"}</TooltipContent>
        </Tooltip>

        {session ? (
          <Breadcrumb className="min-w-0">
            <BreadcrumbList className="flex-nowrap">
              {projectLabel && (
                <>
                  <BreadcrumbItem className="hidden min-w-0 sm:inline-flex">
                    <BreadcrumbLink
                      render={<button type="button" onClick={onGoHome} />}
                      className="max-w-40 truncate"
                    >
                      {projectLabel}
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator className="hidden sm:list-item" />
                </>
              )}
              <BreadcrumbItem className="min-w-0">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <BreadcrumbLink
                        render={<button type="button" onClick={handleCopyResumeCmd} />}
                        className="max-w-64 truncate font-medium text-foreground"
                      />
                    }
                  >
                    {cmdCopied ? (
                      <span className="flex items-center gap-1 text-success">
                        <Check className="size-3.5" />
                        Copied
                      </span>
                    ) : sessionLabel}
                  </TooltipTrigger>
                  <TooltipContent className="flex max-w-sm flex-col gap-1 text-xs">
                    <span>Copy resume command</span>
                    {session.cwd && <span className="truncate font-mono text-muted-foreground">{session.cwd}</span>}
                  </TooltipContent>
                </Tooltip>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        ) : (
          <h1 className="text-sm font-semibold">Cogpit</h1>
        )}

        {isLive && <LiveIndicator aria-label="Session is live" />}
      </div>

      <div className="flex-1" />

      <TokenUsageIndicator agentKind={activeAgentKind} />

      <LeakIndicator />

      <NotificationsBell />

      <DeviceSwitcher />

      <NetworkStatus
        networkUrl={networkUrl}
        urlCopied={urlCopied}
        onCopyUrl={handleCopyNetworkUrl}
      />

      <div className="flex shrink-0 items-center gap-1">
        <PowerMonitor />
        <Button
          variant="outline"
          size="sm"
          onClick={onOpenCommandPalette}
        >
          <Search data-icon="inline-start" />
          Search
          <kbd className="hidden font-mono text-xs text-muted-foreground lg:inline">{commandPaletteShortcut}</kbd>
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon-sm" aria-label="More actions" />}
          >
            <MoreHorizontal data-icon="inline-start" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
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
    </header>
  )
})

// ── NetworkStatus ────────────────────────────────────────────────────────────

interface NetworkStatusProps {
  networkUrl: string | null
  urlCopied: boolean
  onCopyUrl: () => void
}

/**
 * Network URL button. Network access being off is the safe default and renders
 * nothing; being reachable on the LAN is the state worth seeing.
 */
function NetworkStatus({ networkUrl, urlCopied, onCopyUrl }: NetworkStatusProps): React.ReactNode {
  if (!networkUrl) return null

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={onCopyUrl}
            aria-label={urlCopied ? `Copied network URL ${networkUrl}` : `Copy network URL ${networkUrl}`}
          />
        }
      >
          {urlCopied ? <Check data-icon="inline-start" className="text-success" /> : <Globe data-icon="inline-start" className="text-success" />}
      </TooltipTrigger>
      <TooltipContent>{urlCopied ? "Copied" : networkUrl}</TooltipContent>
    </Tooltip>
  )
}
