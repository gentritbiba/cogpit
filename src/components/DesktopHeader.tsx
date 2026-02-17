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
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip"
import type { ParsedSession } from "@/lib/types"
import { cn } from "@/lib/utils"

interface DesktopHeaderProps {
  session: ParsedSession | null
  isLive: boolean
  showSidebar: boolean
  showStats: boolean
  killing: boolean
  onGoHome: () => void
  onToggleSidebar: () => void
  onToggleStats: () => void
  onKillAll: () => void
  onOpenSettings: () => void
}

export function DesktopHeader({
  session,
  isLive,
  showSidebar,
  showStats,
  killing,
  onGoHome,
  onToggleSidebar,
  onToggleStats,
  onKillAll,
  onOpenSettings,
}: DesktopHeaderProps) {
  const [copied, setCopied] = useState(false)

  const copyResumeCmd = useCallback(() => {
    if (!session) return
    const cmd = `claude --resume ${session.sessionId}`
    navigator.clipboard.writeText(cmd)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [session])

  return (
    <header className="flex h-11 shrink-0 items-center border-b border-zinc-800/80 bg-zinc-900/60 glass px-3">
      <div className="flex items-center gap-2 min-w-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onGoHome}
              className="shrink-0 transition-opacity hover:opacity-70"
              aria-label={session ? "Back to Dashboard" : "Agent Window"}
            >
              <Eye className="size-4 text-blue-400" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{session ? "Back to Dashboard" : "Agent Window"}</TooltipContent>
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
          <h1 className="text-sm font-semibold tracking-tight">Agent Window</h1>
        )}
      </div>

      <div className="flex-1" />

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
        {(session || showSidebar) && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onToggleSidebar} aria-label={showSidebar ? "Hide Sidebar" : "Show Sidebar"}>
                {showSidebar ? <PanelLeftClose className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{showSidebar ? "Hide Sidebar (Ctrl+B)" : "Show Sidebar (Ctrl+B)"}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </header>
  )
}
