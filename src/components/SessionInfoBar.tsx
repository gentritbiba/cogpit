import { type Dispatch } from "react"
import {
  Loader2,
  FolderOpen,
  Plus,
  Copy,
  Code2,
  FolderSearch,
  TerminalSquare,
  Bot,
  ChevronRight,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip"
import type { ParsedSession } from "@/lib/types"
import type { SessionSource } from "@/hooks/useLiveSession"
import type { SessionAction } from "@/hooks/useSessionState"
import { shortenModel, formatTokenCount, getContextUsage, parseSubAgentPath } from "@/lib/format"
import { authFetch } from "@/lib/auth"

interface SessionInfoBarProps {
  session: ParsedSession
  sessionSource: SessionSource | null
  creatingSession: boolean
  isMobile: boolean
  dispatch: Dispatch<SessionAction>
  onNewSession: (dirName: string) => void
  onDuplicateSession?: () => void
  onOpenTerminal?: () => void
  onBackToMain?: () => void
}

export function SessionInfoBar({
  session,
  sessionSource,
  creatingSession,
  isMobile,
  dispatch,
  onNewSession,
  onDuplicateSession,
  onOpenTerminal,
  onBackToMain,
}: SessionInfoBarProps) {
  // Detect if viewing a sub-agent session
  const subAgentInfo = sessionSource ? parseSubAgentPath(sessionSource.fileName) : null
  const isSubAgentView = subAgentInfo !== null
  const subAgentId = subAgentInfo?.agentId.slice(0, 8) ?? null

  return (
    <div className={`flex h-8 shrink-0 items-center gap-2 border-b border-border/50 bg-elevation-1 ${isMobile ? "px-2" : "px-3"}`}>
      {isSubAgentView && (
        <>
          {onBackToMain && (
            <button
              onClick={onBackToMain}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-blue-400 hover:bg-blue-500/15 transition-colors"
            >
              <ChevronRight className="size-3 rotate-180" />
              Main
            </button>
          )}
          <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal text-indigo-400 border-indigo-500/30 bg-indigo-500/10 gap-1">
            <Bot className="size-2.5" />
            Agent {subAgentId}
          </Badge>
        </>
      )}
      <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-normal">
        {shortenModel(session.model)}
      </Badge>
      <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal text-muted-foreground border-border">
        {session.turns.length} turns
      </Badge>
      {session.branchedFrom && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal text-purple-400 border-purple-700/50 bg-purple-500/5 gap-1">
              <Copy className="size-2.5" />
              Duplicated
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            Duplicated from {session.branchedFrom.sessionId.slice(0, 8)}
            {session.branchedFrom.turnIndex != null ? ` at turn ${session.branchedFrom.turnIndex + 1}` : ""}
          </TooltipContent>
        </Tooltip>
      )}
      {(() => {
        const ctx = getContextUsage(session.rawMessages)
        if (!ctx) return null
        const pctLeft = Math.max(0, 100 - ctx.percent)
        const remaining = Math.max(0, ctx.compactAt - ctx.used)
        const borderColor = pctLeft < 10 ? "border-red-700/60" : pctLeft < 30 ? "border-amber-700/60" : "border-green-700/60"
        const textColor = pctLeft < 10 ? "text-red-400" : pctLeft < 30 ? "text-amber-400" : "text-green-400"
        const bgColor = pctLeft < 10 ? "bg-red-500/5" : pctLeft < 30 ? "bg-amber-500/5" : "bg-green-500/5"

        if (isMobile) {
          return (
            <Badge
              variant="outline"
              className={`h-5 px-1.5 text-[10px] font-semibold ${borderColor} ${textColor} ${bgColor}`}
            >
              {pctLeft.toFixed(0)}% · {formatTokenCount(remaining)}
            </Badge>
          )
        }

        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge
                variant="outline"
                className={`h-5 px-1.5 text-[10px] font-semibold ${borderColor} ${textColor} ${bgColor} gap-1`}
              >
                {pctLeft.toFixed(0)}% · {formatTokenCount(remaining)}
              </Badge>
            </TooltipTrigger>
            <TooltipContent className="text-xs space-y-1">
              <div className="font-medium">Context Left Until Auto-Compact</div>
              <div>{formatTokenCount(remaining)} remaining ({pctLeft.toFixed(1)}%)</div>
              <div className="text-muted-foreground">
                {formatTokenCount(ctx.used)} / {formatTokenCount(ctx.limit)} tokens used ({ctx.percentAbsolute.toFixed(1)}%)
              </div>
            </TooltipContent>
          </Tooltip>
        )
      })()}

      <div className="flex-1" />

      {sessionSource && !isMobile && (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 gap-1.5 text-[11px] text-muted-foreground hover:text-green-400 hover:bg-green-500/20"
                disabled={creatingSession}
                onClick={() => onNewSession(sessionSource.dirName)}
              >
                {creatingSession ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Plus className="size-3" />
                )}
                New
              </Button>
            </TooltipTrigger>
            <TooltipContent>New session in this project</TooltipContent>
          </Tooltip>
          {onDuplicateSession && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 gap-1.5 text-[11px] text-muted-foreground hover:text-purple-400 hover:bg-purple-500/20"
                  onClick={onDuplicateSession}
                >
                  <Copy className="size-3" />
                  Duplicate
                </Button>
              </TooltipTrigger>
              <TooltipContent>Duplicate this session</TooltipContent>
            </Tooltip>
          )}
          {session.cwd && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 gap-1.5 text-[11px] text-muted-foreground hover:text-blue-400 hover:bg-blue-500/20"
                  onClick={() => authFetch("/api/open-in-editor", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ path: session.cwd }),
                  })}
                >
                  <Code2 className="size-3" />
                  Open
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open project in editor</TooltipContent>
            </Tooltip>
          )}
          {session.cwd && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 gap-1.5 text-[11px] text-zinc-500 hover:text-amber-400 hover:bg-amber-500/10"
                  onClick={() => authFetch("/api/reveal-in-folder", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ path: session.cwd }),
                  })}
                >
                  <FolderSearch className="size-3" />
                  Reveal
                </Button>
              </TooltipTrigger>
              <TooltipContent>Reveal in file manager</TooltipContent>
            </Tooltip>
          )}
          {onOpenTerminal && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 gap-1.5 text-[11px] text-muted-foreground hover:text-emerald-400 hover:bg-emerald-500/20"
                  onClick={onOpenTerminal}
                >
                  <TerminalSquare className="size-3" />
                  Terminal
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open terminal in project</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 gap-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                onClick={() => {
                  const dirName = sessionSource.dirName
                  dispatch({ type: "GO_HOME", isMobile: false })
                  dispatch({ type: "SET_DASHBOARD_PROJECT", dirName })
                }}
              >
                <FolderOpen className="size-3" />
                All Sessions
              </Button>
            </TooltipTrigger>
            <TooltipContent>View all sessions in this project</TooltipContent>
          </Tooltip>
        </>
      )}

      {sessionSource && isMobile && (
        <>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 gap-1 text-[11px] text-muted-foreground hover:text-green-400 hover:bg-green-500/20"
            disabled={creatingSession}
            onClick={() => onNewSession(sessionSource.dirName)}
          >
            {creatingSession ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
            New
          </Button>
          {onDuplicateSession && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 gap-1 text-[11px] text-muted-foreground hover:text-purple-400 hover:bg-purple-500/20"
              onClick={onDuplicateSession}
            >
              <Copy className="size-3" />
              Duplicate
            </Button>
          )}
        </>
      )}
    </div>
  )
}
