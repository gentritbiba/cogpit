import { useState, useCallback } from "react"
import {
  Eye,
  Check,
  Copy,
  Loader2,
  Skull,
  Plus,
  Settings,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import type { ParsedSession } from "@/lib/types"
import type { SessionSource } from "@/hooks/useLiveSession"
import { getContextUsage } from "@/lib/format"
import { cn } from "@/lib/utils"

interface MobileHeaderProps {
  session: ParsedSession | null
  sessionSource: SessionSource | null
  isLive: boolean
  killing: boolean
  creatingSession: boolean
  onGoHome: () => void
  onKillAll: () => void
  onOpenSettings: () => void
  onNewSession: (dirName: string) => void
}

export function MobileHeader({
  session,
  sessionSource,
  isLive,
  killing,
  creatingSession,
  onGoHome,
  onKillAll,
  onOpenSettings,
  onNewSession,
}: MobileHeaderProps) {
  const [copied, setCopied] = useState(false)

  const copyResumeCmd = useCallback(() => {
    if (!session) return
    const cmd = `claude --resume ${session.sessionId}`
    navigator.clipboard.writeText(cmd)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [session])

  return (
    <header className="flex h-12 shrink-0 items-center border-b border-zinc-800/80 bg-zinc-900/60 glass px-3">
      {/* Left: Identity */}
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <button onClick={onGoHome} className="shrink-0 transition-opacity hover:opacity-70" aria-label={session ? "Back to Dashboard" : "Agent Window"}>
          <Eye className="size-4 text-blue-400" />
        </button>
        {session ? (
          <>
            <button
              className="truncate text-sm font-medium text-zinc-300 min-w-0"
              onClick={copyResumeCmd}
            >
              {copied ? (
                <span className="text-green-400">Copied!</span>
              ) : (
                session.slug || session.sessionId.slice(0, 12)
              )}
            </button>
            {isLive && (
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
              </span>
            )}
            {(() => {
              const ctx = getContextUsage(session.rawMessages)
              if (!ctx) return null
              const pctLeft = Math.max(0, 100 - ctx.percent)
              const borderColor = pctLeft < 10 ? "border-red-700/60" : pctLeft < 30 ? "border-amber-700/60" : "border-green-700/60"
              const textColor = pctLeft < 10 ? "text-red-400" : pctLeft < 30 ? "text-amber-400" : "text-green-400"
              const bgColor = pctLeft < 10 ? "bg-red-500/5" : pctLeft < 30 ? "bg-amber-500/5" : "bg-green-500/5"
              return (
                <Badge
                  variant="outline"
                  className={`h-5 px-1.5 text-[10px] font-semibold ${borderColor} ${textColor} ${bgColor} shrink-0`}
                >
                  {pctLeft.toFixed(0)}%
                </Badge>
              )
            })()}
          </>
        ) : (
          <h1 className="text-sm font-semibold tracking-tight">Agent Window</h1>
        )}
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-0.5 shrink-0">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 text-zinc-500 shrink-0"
          onClick={onOpenSettings}
          aria-label="Settings"
        >
          <Settings className="size-3.5" />
        </Button>
        {session && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 text-zinc-500 shrink-0"
            onClick={copyResumeCmd}
            aria-label={copied ? "Copied!" : "Copy resume command"}
          >
            {copied ? (
              <Check className="size-3.5 text-green-400" />
            ) : (
              <Copy className="size-3.5" />
            )}
          </Button>
        )}
        {sessionSource && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 text-zinc-500 hover:text-green-400"
            disabled={creatingSession}
            onClick={() => onNewSession(sessionSource.dirName)}
            aria-label={creatingSession ? "Creating session..." : "New session"}
          >
            {creatingSession ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Plus className="size-3.5" />
            )}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 text-zinc-500 hover:text-red-400"
          onClick={onKillAll}
          disabled={killing}
          aria-label="Kill all Claude processes"
        >
          <Skull className={cn("size-3.5", killing && "text-red-400 animate-pulse")} />
        </Button>
      </div>
    </header>
  )
}
