import { type Dispatch, memo } from "react"
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
import { shortenModel, parseSubAgentPath } from "@/lib/format"
import { formatAgentLabel } from "@/components/timeline/agent-utils"
import { ContextBadge, HeaderActionButton } from "@/components/header-shared"
import { authFetch } from "@/lib/auth"

interface SessionInfoBarProps {
  session: ParsedSession
  sessionSource: SessionSource | null
  creatingSession: boolean
  isMobile: boolean
  dispatch: Dispatch<SessionAction>
  onNewSession: (dirName: string, cwd?: string) => void
  onDuplicateSession?: () => void
  onOpenTerminal?: () => void
  onBackToMain?: () => void
}

export const SessionInfoBar = memo(function SessionInfoBar({
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
  const subAgentInfo = sessionSource ? parseSubAgentPath(sessionSource.fileName) : null
  const isSubAgentView = subAgentInfo !== null
  const subAgentLabel = subAgentInfo ? formatAgentLabel(subAgentInfo.agentId) : null

  return (
    <div className={`flex h-8 shrink-0 items-center gap-2 border-b border-border/50 bg-elevation-1 ${isMobile ? "px-2" : "px-3"}`}>
      {/* Sub-agent navigation */}
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
            Agent {subAgentLabel}
          </Badge>
        </>
      )}

      {/* Session metadata badges */}
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

      <ContextBadge
        rawMessages={session.rawMessages}
        showRemaining
        showTooltip={!isMobile}
      />

      <div className="flex-1" />

      {/* Action buttons */}
      {sessionSource && (
        <SessionActions
          session={session}
          sessionSource={sessionSource}
          creatingSession={creatingSession}
          isMobile={isMobile}
          dispatch={dispatch}
          onNewSession={onNewSession}
          onDuplicateSession={onDuplicateSession}
          onOpenTerminal={onOpenTerminal}
        />
      )}
    </div>
  )
})

// ── SessionActions ───────────────────────────────────────────────────────────

interface SessionActionsProps {
  session: ParsedSession
  sessionSource: SessionSource
  creatingSession: boolean
  isMobile: boolean
  dispatch: Dispatch<SessionAction>
  onNewSession: (dirName: string, cwd?: string) => void
  onDuplicateSession?: () => void
  onOpenTerminal?: () => void
}

/**
 * Action buttons shown in the session info bar. On mobile only "New" and
 * "Duplicate" are shown (without tooltips). On desktop the full set of
 * project-level actions is shown with tooltips.
 */
function SessionActions({
  session,
  sessionSource,
  creatingSession,
  isMobile,
  dispatch,
  onNewSession,
  onDuplicateSession,
  onOpenTerminal,
}: SessionActionsProps): React.ReactNode {
  const newIcon = creatingSession
    ? <Loader2 className="size-3 animate-spin" />
    : <Plus className="size-3" />

  function handleNewSession(): void {
    onNewSession(sessionSource.dirName, session.cwd)
  }

  if (isMobile) {
    return (
      <>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 gap-1 text-[11px] text-muted-foreground hover:text-green-400 hover:bg-green-500/20"
          disabled={creatingSession}
          onClick={handleNewSession}
        >
          {newIcon}
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
    )
  }

  return (
    <>
      <HeaderActionButton
        icon={newIcon}
        label="New"
        tooltip="New session in this project"
        onClick={handleNewSession}
        disabled={creatingSession}
        className="text-muted-foreground hover:text-green-400 hover:bg-green-500/20"
      />
      {onDuplicateSession && (
        <HeaderActionButton
          icon={<Copy className="size-3" />}
          label="Duplicate"
          tooltip="Duplicate this session"
          onClick={onDuplicateSession}
          className="text-muted-foreground hover:text-purple-400 hover:bg-purple-500/20"
        />
      )}
      {session.cwd && (
        <HeaderActionButton
          icon={<Code2 className="size-3" />}
          label="Open"
          tooltip="Open project in editor"
          onClick={() => authFetch("/api/open-in-editor", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: session.cwd }),
          })}
          className="text-muted-foreground hover:text-blue-400 hover:bg-blue-500/20"
        />
      )}
      {session.cwd && (
        <HeaderActionButton
          icon={<FolderSearch className="size-3" />}
          label="Reveal"
          tooltip="Reveal in file manager"
          onClick={() => authFetch("/api/reveal-in-folder", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: session.cwd }),
          })}
          className="text-zinc-500 hover:text-amber-400 hover:bg-amber-500/10"
        />
      )}
      {onOpenTerminal && (
        <HeaderActionButton
          icon={<TerminalSquare className="size-3" />}
          label="Terminal"
          tooltip="Open terminal in project"
          onClick={onOpenTerminal}
          className="text-muted-foreground hover:text-emerald-400 hover:bg-emerald-500/20"
        />
      )}
      <HeaderActionButton
        icon={<FolderOpen className="size-3" />}
        label="All Sessions"
        tooltip="View all sessions in this project"
        onClick={() => {
          const dirName = sessionSource.dirName
          dispatch({ type: "GO_HOME", isMobile: false })
          dispatch({ type: "SET_DASHBOARD_PROJECT", dirName })
        }}
        className="text-muted-foreground hover:text-foreground"
      />
    </>
  )
}
