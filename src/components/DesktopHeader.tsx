import { useState, useCallback, memo } from "react"
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
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip"
import type { ParsedSession } from "@/lib/types"
import { cn, copyToClipboard } from "@/lib/utils"
import { TokenUsageIndicator } from "@/components/TokenUsageWidget"

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
}: DesktopHeaderProps) {
  const [copied, setCopied] = useState(false)
  const [urlCopied, setUrlCopied] = useState(false)

  const copyNetworkUrl = useCallback(async () => {
    if (!networkUrl) return
    const ok = await copyToClipboard(networkUrl)
    if (!ok) return
    setUrlCopied(true)
    setTimeout(() => setUrlCopied(false), 1500)
  }, [networkUrl])

  const copyResumeCmd = useCallback(async () => {
    if (!session) return
    const cmd = `claude --resume ${session.sessionId}`
    const ok = await copyToClipboard(cmd)
    if (!ok) return
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [session])

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

        {session ? (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="truncate max-w-[220px] text-sm font-medium text-foreground hover:text-foreground transition-colors"
                  onClick={copyResumeCmd}
                >
                  {copied ? (
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
            {isLive && (
              <span className="relative flex h-2 w-2 shrink-0" aria-label="Session is live" role="status">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
              </span>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground"
                  onClick={copyResumeCmd}
                  aria-label={copied ? "Copied!" : "Copy resume command"}
                >
                  {copied ? (
                    <Check className="size-3 text-green-400" />
                  ) : (
                    <Copy className="size-3" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {copied ? "Copied!" : "Copy resume command"}
              </TooltipContent>
            </Tooltip>
          </>
        ) : (
          <h1 className="text-sm font-semibold tracking-tight">Cogpit</h1>
        )}
      </div>

      <div className="flex-1" />

      <TokenUsageIndicator />

      {networkUrl ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={copyNetworkUrl}
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
      ) : networkAccessDisabled ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground mr-1">
              <WifiOff className="size-3" />
              <span>Network off</span>
            </div>
          </TooltipTrigger>
          <TooltipContent>Network access is disabled</TooltipContent>
        </Tooltip>
      ) : null}

      <div className="flex items-center gap-1 shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
              onClick={onOpenSettings}
              aria-label="Settings"
            >
              <Settings className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Settings</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-muted-foreground hover:text-red-400 hover:bg-red-500/10"
              onClick={onKillAll}
              disabled={killing}
              aria-label="Kill all Claude processes"
            >
              <Skull className={cn("size-3.5", killing && "text-red-400 animate-pulse")} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Kill all Claude processes</TooltipContent>
        </Tooltip>
        {onToggleWorktrees && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className={cn("h-7 w-7 p-0", showWorktrees ? "text-foreground" : "text-muted-foreground hover:text-foreground")}
                onClick={onToggleWorktrees}
                aria-label={showWorktrees ? "Hide Worktrees" : "Show Worktrees"}
              >
                <GitBranch className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{showWorktrees ? "Hide Worktrees" : "Show Worktrees"}</TooltipContent>
          </Tooltip>
        )}
        {session && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onToggleStats} aria-label={showStats ? "Hide Stats" : "Show Stats"}>
                {showStats ? <PanelRightClose className="size-3.5" /> : <BarChart3 className="size-3.5" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{showStats ? "Hide Stats" : "Show Stats"}</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onToggleSidebar} aria-label={showSidebar ? "Hide Sidebar" : "Show Sidebar"}>
              {showSidebar ? <PanelLeftClose className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{showSidebar ? "Hide Sidebar (Ctrl+B)" : "Show Sidebar (Ctrl+B)"}</TooltipContent>
        </Tooltip>
      </div>
    </header>
  )
})
