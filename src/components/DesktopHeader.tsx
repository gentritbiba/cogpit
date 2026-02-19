import { useState, useCallback } from "react"
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
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip"
import type { ParsedSession } from "@/lib/types"
import { cn, copyToClipboard } from "@/lib/utils"
import type { UsageStats } from "@/hooks/useUsageStats"
import { getSessionLimit, getWeeklyLimit } from "@/hooks/useUsageStats"

interface DesktopHeaderProps {
  session: ParsedSession | null
  isLive: boolean
  showSidebar: boolean
  showStats: boolean
  killing: boolean
  networkUrl: string | null
  networkAccessDisabled: boolean
  usage: UsageStats | null
  onGoHome: () => void
  onToggleSidebar: () => void
  onToggleStats: () => void
  onKillAll: () => void
  onOpenSettings: () => void
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
  return String(n)
}

function usageColor(pct: number): string {
  if (pct >= 80) return "text-red-400"
  if (pct >= 50) return "text-amber-400"
  return "text-emerald-400"
}

function barColor(pct: number): string {
  if (pct >= 80) return "bg-red-400"
  if (pct >= 50) return "bg-amber-400"
  return "bg-emerald-400"
}

function formatResetTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}

function formatResetDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}

export function DesktopHeader({
  session,
  isLive,
  showSidebar,
  showStats,
  killing,
  networkUrl,
  networkAccessDisabled,
  usage,
  onGoHome,
  onToggleSidebar,
  onToggleStats,
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
    <header className="flex h-11 shrink-0 items-center border-b border-zinc-800/80 bg-zinc-900/60 glass px-3 electron-drag">
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
                  className="truncate max-w-[220px] text-sm font-medium text-zinc-300 hover:text-zinc-100 transition-colors"
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
                  <div className="font-mono text-zinc-400">{session.cwd}</div>
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
                  className="h-5 w-5 p-0 text-zinc-500 hover:text-zinc-200"
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

      {networkUrl ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={copyNetworkUrl}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-mono text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50 transition-colors mr-1"
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
            <div className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-zinc-600 mr-1">
              <WifiOff className="size-3" />
              <span>Network off</span>
            </div>
          </TooltipTrigger>
          <TooltipContent>Network access is disabled</TooltipContent>
        </Tooltip>
      ) : null}

      {usage && (
        <div className="flex items-center gap-2 mr-2 shrink-0">
          {/* Session window usage */}
          {(() => {
            const sessionLimit = getSessionLimit(usage.subscriptionType)
            const sessionPct = Math.min(100, Math.round((usage.sessionWindow.outputTokens / sessionLimit) * 100))
            return (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-1.5 cursor-default">
                    <span className={cn("text-[11px] font-medium tabular-nums", usageColor(sessionPct))}>
                      S {sessionPct}%
                    </span>
                    <div className="w-8 h-1 rounded-full bg-zinc-700 overflow-hidden">
                      <div
                        className={cn("h-full rounded-full transition-all", barColor(sessionPct))}
                        style={{ width: `${sessionPct}%` }}
                      />
                    </div>
                  </div>
                </TooltipTrigger>
                <TooltipContent className="text-xs space-y-1">
                  <div className="font-medium">Session window</div>
                  <div>{formatTokens(usage.sessionWindow.outputTokens)} / ~{formatTokens(sessionLimit)} output tokens</div>
                  <div className="text-zinc-400">Resets {formatResetTime(usage.sessionWindow.resetAt)}</div>
                </TooltipContent>
              </Tooltip>
            )
          })()}
          {/* Weekly usage */}
          {(() => {
            const weeklyLimit = getWeeklyLimit(usage.subscriptionType)
            const weeklyPct = Math.min(100, Math.round((usage.weekly.outputTokens / weeklyLimit) * 100))
            return (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-1.5 cursor-default">
                    <span className={cn("text-[11px] font-medium tabular-nums", usageColor(weeklyPct))}>
                      W {weeklyPct}%
                    </span>
                    <div className="w-8 h-1 rounded-full bg-zinc-700 overflow-hidden">
                      <div
                        className={cn("h-full rounded-full transition-all", barColor(weeklyPct))}
                        style={{ width: `${weeklyPct}%` }}
                      />
                    </div>
                  </div>
                </TooltipTrigger>
                <TooltipContent className="text-xs space-y-1">
                  <div className="font-medium">Weekly usage</div>
                  <div>{formatTokens(usage.weekly.outputTokens)} / ~{formatTokens(weeklyLimit)} output tokens</div>
                  <div className="text-zinc-400">Resets {formatResetDate(usage.weekly.resetAt)}</div>
                </TooltipContent>
              </Tooltip>
            )
          })()}
        </div>
      )}

      <div className="flex items-center gap-1 shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-zinc-500 hover:text-zinc-200"
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
              className="h-7 w-7 p-0 text-zinc-500 hover:text-red-400 hover:bg-red-500/10"
              onClick={onKillAll}
              disabled={killing}
              aria-label="Kill all Claude processes"
            >
              <Skull className={cn("size-3.5", killing && "text-red-400 animate-pulse")} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Kill all Claude processes</TooltipContent>
        </Tooltip>
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
}
