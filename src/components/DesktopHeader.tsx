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
  FileCode2,
  Rows2,
  Columns2,
  Maximize2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip"
import { TokenUsageIndicator } from "@/components/TokenUsageWidget"
import { LiveIndicator, HeaderIconButton } from "@/components/header-shared"
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext } from "@/contexts/SessionContext"
import { agentKindFromDirName, getResumeCommand } from "@/lib/sessionSource"
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
  showConfig?: boolean
  onToggleConfig?: () => void
  layoutMode?: "stacked" | "side-by-side" | "focused"
  onSetLayoutMode?: (mode: "stacked" | "side-by-side" | "focused") => void
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
  showConfig,
  onToggleConfig,
  layoutMode,
  onSetLayoutMode,
}: DesktopHeaderProps) {
  const { config: { networkUrl, networkAccessDisabled } } = useAppContext()
  const { session, sessionSource, isLive } = useSessionContext()
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
              onClick={onGoHome}
              className="shrink-0 transition-opacity hover:opacity-70"
              aria-label={session ? "Back to Dashboard" : "ClaudeView"}
            />}>
              <Eye className="size-4 text-blue-400" />
          </TooltipTrigger>
          <TooltipContent>{session ? "Back to Dashboard" : "ClaudeView"}</TooltipContent>
        </Tooltip>

        <span className="text-[11px] font-medium text-muted-foreground/60 select-none">ClaudeView</span>

        {session ? (
          <>
            <Tooltip>
              <TooltipTrigger render={<button
                  className="truncate max-w-[220px] text-sm font-medium text-foreground hover:text-foreground transition-colors"
                  onClick={handleCopyResumeCmd}
                />}>
                  {cmdCopied ? (
                    <span className="flex items-center gap-1.5 text-green-400">
                      <Check className="size-3" /> Copied
                    </span>
                  ) : (
                    session.cwd?.split("/").pop() || session.slug || session.sessionId.slice(0, 8)
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
            <Tooltip>
              <TooltipTrigger render={<Button
                  variant="ghost"
                  size="sm"
                  className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground"
                  onClick={handleCopyResumeCmd}
                  aria-label={cmdCopied ? "Copied!" : "Copy resume command"}
                />}>
                  {cmdCopied ? (
                    <Check className="size-3 text-green-400" />
                  ) : (
                    <Copy className="size-3" />
                  )}
              </TooltipTrigger>
              <TooltipContent>
                {cmdCopied ? "Copied!" : "Copy resume command"}
              </TooltipContent>
            </Tooltip>
          </>
        ) : (
          <h1 className="text-sm font-semibold tracking-tight">ClaudeView</h1>
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

      <div className="flex items-center gap-0.5 shrink-0">
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
          label="Kill all tracked agent processes"
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
        {hasFileChanges && onToggleFileChanges && (
          <HeaderIconButton
            icon={FileCode2}
            label={showFileChanges ? "Hide File Changes" : "Show File Changes"}
            onClick={onToggleFileChanges}
            className={showFileChanges ? "text-amber-400" : "text-muted-foreground hover:text-foreground"}
            iconClassName={showFileChanges ? "text-amber-400" : undefined}
          />
        )}
        {onSetLayoutMode && (
          <>
            <HeaderIconButton
              icon={Rows2}
              label="Stacked layout"
              onClick={() => onSetLayoutMode("stacked")}
              className={layoutMode === "stacked" ? "text-blue-400" : "text-muted-foreground hover:text-foreground"}
            />
            <HeaderIconButton
              icon={Columns2}
              label="Side-by-side layout"
              onClick={() => onSetLayoutMode("side-by-side")}
              className={layoutMode === "side-by-side" ? "text-blue-400" : "text-muted-foreground hover:text-foreground"}
            />
            <HeaderIconButton
              icon={Maximize2}
              label="Focused layout (hide file changes)"
              onClick={() => onSetLayoutMode("focused")}
              className={layoutMode === "focused" ? "text-blue-400" : "text-muted-foreground hover:text-foreground"}
            />
          </>
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
  networkAccessDisabled: boolean
  urlCopied: boolean
  onCopyUrl: () => void
}

/** Renders the network URL button or "Network off" indicator. */
function NetworkStatus({ networkUrl, networkAccessDisabled, urlCopied, onCopyUrl }: NetworkStatusProps): React.ReactNode {
  if (networkUrl) {
    return (
      <Tooltip>
        <TooltipTrigger render={<button
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
        <TooltipContent>Click to copy connection URL</TooltipContent>
      </Tooltip>
    )
  }

  if (networkAccessDisabled) {
    return (
      <Tooltip>
        <TooltipTrigger render={<div className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground mr-1" />}>
            <WifiOff className="size-3" />
            <span>Network off</span>
        </TooltipTrigger>
        <TooltipContent>Network access is disabled</TooltipContent>
      </Tooltip>
    )
  }

  return null
}
