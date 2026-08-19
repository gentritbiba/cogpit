import { memo } from "react"
import {
  ChevronRight,
  Eye,
  BarChart3,
  PanelLeftClose,
  PanelRightClose,
  Check,
  Skull,
  Settings,
  Globe,
  GitBranch,
  SlidersHorizontal,
  FileCode2,
  Search,
} from "lucide-react"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip"
import { TokenUsageIndicator } from "@/components/TokenUsageWidget"
import { LeakIndicator } from "@/components/LeakIndicator"
import { PowerMonitor } from "@/components/PowerMonitor"
import { LiveIndicator, HeaderIconButton } from "@/components/header-shared"
import { DeviceSwitcher } from "@/components/DeviceSwitcher"
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback"
import { can } from "@/lib/capabilities"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext } from "@/contexts/SessionContext"
import { agentKindFromDirName, getResumeCommand } from "@/lib/sessionSource"
import { MissionControlButton } from "@/components/MissionControl/MissionControlButton"
import packageJson from "../../package.json"

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

  return (
    <header className="flex h-8 shrink-0 items-center border-b border-border/50 bg-elevation-2 px-2.5 electron-drag">
      <div className="flex items-center gap-2 min-w-0">
        <Tooltip>
          <TooltipTrigger render={<button
              type="button"
              onClick={onGoHome}
              className="shrink-0 transition-opacity hover:opacity-70"
              aria-label={session ? "Back to Dashboard" : "Cogpit"}
            />}>
              <Eye className="size-4 text-blue-400" />
          </TooltipTrigger>
          <TooltipContent>{session ? "Back to Dashboard" : "Cogpit"}</TooltipContent>
        </Tooltip>

        <span className="text-[10px] font-mono text-muted-foreground/50 select-none">v{packageJson.version}</span>

        {session ? (
          <>
            <Tooltip>
              <TooltipTrigger render={<button
                  type="button"
                  className="truncate max-w-[220px] text-sm font-medium text-foreground hover:text-foreground transition-colors"
                  onClick={handleCopyResumeCmd}
                />}>
                  {cmdCopied ? (
                    <span className="flex items-center gap-1.5 text-green-400">
                      <Check className="size-3" /> Copied
                    </span>
                  ) : (
                    session.slug || session.sessionId.slice(0, 8)
                  )}
              </TooltipTrigger>
              <TooltipContent className="text-xs space-y-1">
                <div>Click to copy resume command</div>
                {session.cwd && (
                  <div className="font-mono text-muted-foreground">{session.cwd}</div>
                )}
              </TooltipContent>
            </Tooltip>
            {isLive && <LiveIndicator aria-label="Session is live" />}
          </>
        ) : (
          <h1 className="text-sm font-semibold tracking-tight">Cogpit</h1>
        )}
      </div>

      <div className="flex-1" />

      <TokenUsageIndicator agentKind={activeAgentKind} />

      <LeakIndicator />

      <DeviceSwitcher />

      <NetworkStatus
        networkUrl={networkUrl}
        urlCopied={urlCopied}
        onCopyUrl={handleCopyNetworkUrl}
      />

      <div className="flex items-center gap-0.5 shrink-0">
        <PowerMonitor />
        <HeaderIconButton
          icon={Search}
          label={`Command palette (${commandPaletteShortcut})`}
          onClick={onOpenCommandPalette}
        />
        {onToggleMission && (
          <MissionControlButton active={showMission ?? false} onToggle={onToggleMission} />
        )}
        {onToggleConfig && (
          <HeaderIconButton
            icon={SlidersHorizontal}
            label={showConfig ? "Close Config Browser" : "Config Browser"}
            onClick={onToggleConfig}
            className={showConfig ? "bg-blue-500/20" : undefined}
            iconClassName={showConfig ? "text-blue-400" : undefined}
          />
        )}
        <HeaderIconButton
          icon={Settings}
          label="Settings"
          onClick={onOpenSettings}
        />
        {can("killAny") && (
          <HeaderIconButton
            icon={Skull}
            label="Kill all tracked agent processes"
            onClick={onKillAll}
            disabled={killing}
            className="hover:text-red-400 hover:bg-red-500/10"
            iconClassName={killing ? "text-red-400" : undefined}
          />
        )}
        {onToggleWorktrees && (
          <HeaderIconButton
            icon={GitBranch}
            label={showWorktrees ? "Hide Worktrees" : "Show Worktrees"}
            onClick={onToggleWorktrees}
            className={showWorktrees ? "text-foreground" : undefined}
          />
        )}
        {hasFileChanges && onToggleFileChanges && (
          <HeaderIconButton
            icon={FileCode2}
            label={showFileChanges ? "Hide File Changes" : "Show File Changes"}
            onClick={onToggleFileChanges}
            className={showFileChanges ? "text-amber-400" : undefined}
            iconClassName={showFileChanges ? "text-amber-400" : undefined}
          />
        )}
        <HeaderIconButton
          icon={showSidebar ? PanelLeftClose : ChevronRight}
          label={showSidebar ? "Hide Sidebar (Ctrl+B)" : "Show Sidebar (Ctrl+B)"}
          onClick={onToggleSidebar}
        />
        {session && (
          <HeaderIconButton
            icon={showStats ? PanelRightClose : BarChart3}
            label={showStats ? "Hide Stats (⌘⇧B)" : "Show Stats (⌘⇧B)"}
            onClick={onToggleStats}
          />
        )}
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
      <TooltipTrigger render={<button
          type="button"
          onClick={onCopyUrl}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-mono text-muted-foreground hover:text-foreground hover:bg-elevation-2 transition-colors mr-1"
        />}>
          <Globe className="size-3 text-green-500" />
          {urlCopied ? (
            <span className="text-green-400">Copied!</span>
          ) : (
            networkUrl
          )}
      </TooltipTrigger>
      <TooltipContent>Reachable on your network — click to copy the connection URL</TooltipContent>
    </Tooltip>
  )
}
