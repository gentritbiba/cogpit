import { memo } from "react"
import {
  ChevronRight,
  Eye,
  BarChart3,
  PanelLeftClose,
  PanelRightClose,
  Check,
  Copy,
  Skull,
  Settings,
  Globe,
  WifiOff,
  GitBranch,
  SlidersHorizontal,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip"
import type { ParsedSession } from "@/lib/types"
import { TokenUsageIndicator } from "@/components/TokenUsageWidget"
import { LiveIndicator, HeaderIconButton } from "@/components/header-shared"
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback"
import packageJson from "../../package.json"

interface DesktopHeaderProps {
  session: ParsedSession | null
  isLive: boolean
  showSidebar: boolean
  showStats: boolean
  showWorktrees?: boolean
  killing: boolean
  networkUrl: string | null
  networkAccessDisabled: boolean
  onGoHome: () => void
  onToggleSidebar: () => void
  onToggleStats: () => void
  onToggleWorktrees?: () => void
  onKillAll: () => void
  onOpenSettings: () => void
  showConfig?: boolean
  onToggleConfig?: () => void
}

export const DesktopHeader = memo(function DesktopHeader({
  session,
  isLive,
  showSidebar,
  showStats,
  showWorktrees,
  killing,
  networkUrl,
  networkAccessDisabled,
  onGoHome,
  onToggleSidebar,
  onToggleStats,
  onToggleWorktrees,
  onKillAll,
  onOpenSettings,
  showConfig,
  onToggleConfig,
}: DesktopHeaderProps) {
  const [cmdCopied, copyCmd] = useCopyWithFeedback()
  const [urlCopied, copyUrl] = useCopyWithFeedback()

  function handleCopyResumeCmd(): void {
    if (!session) return
    copyCmd(`claude --resume ${session.sessionId}`)
  }

  function handleCopyNetworkUrl(): void {
    if (!networkUrl) return
    copyUrl(networkUrl)
  }

  return (
    <header className="flex h-11 shrink-0 items-center border-b border-border/50 bg-elevation-2 depth-mid px-3 electron-drag">
      <div className="flex items-center gap-2 min-w-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onGoHome}
              className="shrink-0 transition-opacity hover:opacity-70"
              aria-label={session ? "Back to Dashboard" : "Cogpit"}
            >
              <Eye className="size-4 text-blue-400" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{session ? "Back to Dashboard" : "Cogpit"}</TooltipContent>
        </Tooltip>

        <span className="text-[10px] font-mono text-muted-foreground/50 select-none">v{packageJson.version}</span>

        {session ? (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="truncate max-w-[220px] text-sm font-medium text-foreground hover:text-foreground transition-colors"
                  onClick={handleCopyResumeCmd}
                >
                  {cmdCopied ? (
                    <span className="flex items-center gap-1.5 text-green-400">
                      <Check className="size-3" /> Copied
                    </span>
                  ) : (
                    session.slug || session.sessionId.slice(0, 8)
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent className="text-xs space-y-1">
                <div>Click to copy resume command</div>
                {session.cwd && (
                  <div className="font-mono text-muted-foreground">{session.cwd}</div>
                )}
              </TooltipContent>
            </Tooltip>
            {isLive && <LiveIndicator aria-label="Session is live" />}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground"
                  onClick={handleCopyResumeCmd}
                  aria-label={cmdCopied ? "Copied!" : "Copy resume command"}
                >
                  {cmdCopied ? (
                    <Check className="size-3 text-green-400" />
                  ) : (
                    <Copy className="size-3" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {cmdCopied ? "Copied!" : "Copy resume command"}
              </TooltipContent>
            </Tooltip>
          </>
        ) : (
          <h1 className="text-sm font-semibold tracking-tight">Cogpit</h1>
        )}
      </div>

      <div className="flex-1" />

      <TokenUsageIndicator />

      <NetworkStatus
        networkUrl={networkUrl}
        networkAccessDisabled={networkAccessDisabled}
        urlCopied={urlCopied}
        onCopyUrl={handleCopyNetworkUrl}
      />

      <div className="flex items-center gap-1 shrink-0">
        {onToggleConfig && (
          <HeaderIconButton
            icon={SlidersHorizontal}
            label={showConfig ? "Close Config Browser" : "Config Browser"}
            onClick={onToggleConfig}
            className={showConfig ? "bg-blue-500/20" : "text-muted-foreground hover:text-foreground"}
            iconClassName={showConfig ? "text-blue-400" : undefined}
          />
        )}
        <HeaderIconButton
          icon={Settings}
          label="Settings"
          onClick={onOpenSettings}
          className="text-muted-foreground hover:text-foreground"
        />
        <HeaderIconButton
          icon={Skull}
          label="Kill all Claude processes"
          onClick={onKillAll}
          disabled={killing}
          className="text-muted-foreground hover:text-red-400 hover:bg-red-500/10"
          iconClassName={killing ? "text-red-400 animate-pulse" : undefined}
        />
        {onToggleWorktrees && (
          <HeaderIconButton
            icon={GitBranch}
            label={showWorktrees ? "Hide Worktrees" : "Show Worktrees"}
            onClick={onToggleWorktrees}
            className={showWorktrees ? "text-foreground" : "text-muted-foreground hover:text-foreground"}
          />
        )}
        {session && (
          <HeaderIconButton
            icon={showStats ? PanelRightClose : BarChart3}
            label={showStats ? "Hide Stats" : "Show Stats"}
            onClick={onToggleStats}
          />
        )}
        <HeaderIconButton
          icon={showSidebar ? PanelLeftClose : ChevronRight}
          label={showSidebar ? "Hide Sidebar (Ctrl+B)" : "Show Sidebar (Ctrl+B)"}
          onClick={onToggleSidebar}
        />
      </div>
    </header>
  )
})

// ── NetworkStatus ────────────────────────────────────────────────────────────

interface NetworkStatusProps {
  networkUrl: string | null
  networkAccessDisabled: boolean
  urlCopied: boolean
  onCopyUrl: () => void
}

/** Renders the network URL button or "Network off" indicator. */
function NetworkStatus({ networkUrl, networkAccessDisabled, urlCopied, onCopyUrl }: NetworkStatusProps): React.ReactNode {
  if (networkUrl) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={onCopyUrl}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-mono text-muted-foreground hover:text-foreground hover:bg-elevation-2 transition-colors mr-1"
          >
            <Globe className="size-3 text-green-500" />
            {urlCopied ? (
              <span className="text-green-400">Copied!</span>
            ) : (
              networkUrl
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent>Click to copy connection URL</TooltipContent>
      </Tooltip>
    )
  }

  if (networkAccessDisabled) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground mr-1">
            <WifiOff className="size-3" />
            <span>Network off</span>
          </div>
        </TooltipTrigger>
        <TooltipContent>Network access is disabled</TooltipContent>
      </Tooltip>
    )
  }

  return null
}
