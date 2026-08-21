import { memo, startTransition } from "react"
import type { ReactNode } from "react"
import {
  Check,
  Code2,
  Copy,
  FolderOpen,
  FolderSearch,
  Plus,
  TerminalSquare,
} from "lucide-react"
import { Spinner } from "@/components/ui/Spinner"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { PullRequestChips } from "@/components/PullRequestChips"
import { ContextBadge, FLOATING_PILL, LiveIndicator } from "@/components/header-shared"
import { formatAgentLabel } from "@/components/timeline/agent-utils"
import { useAppContext } from "@/contexts/AppContext"
import type { SessionSource } from "@/hooks/useLiveSession"
import { can } from "@/lib/capabilities"
import { isRemoteDeviceActive } from "@/lib/device"
import { isBuiltInEditorEnabled, openProject, revealInFolder } from "@/lib/fileOpener"
import {
  formatTokenCount,
  getContextUsage,
  parseSubAgentPath,
  projectName,
  shortenModel,
} from "@/lib/format"
import type { ParsedSession, RawMessage } from "@/lib/types"
import { cn } from "@/lib/utils"
import type { SessionPullRequest } from "../../shared/session/prLinks"

interface SessionPillProps {
  session: ParsedSession
  sessionSource: SessionSource | null
  isLive: boolean
  pullRequests: SessionPullRequest[]
  copied: boolean
  creatingSession: boolean
  onCopyResume: () => void
  onNewSession: (dirName: string, cwd?: string) => void
  onDuplicateSession?: () => void
  onOpenTerminal?: () => void
}

/**
 * `project / session · ● · model · 82%` as one floating pill. Click copies the
 * resume command, right-click opens the session menu, hover lists the rest of
 * the session state (branch, pull requests, agent, context detail).
 */
export const SessionPill = memo(function SessionPill({
  session,
  sessionSource,
  isLive,
  pullRequests,
  copied,
  creatingSession,
  onCopyResume,
  onNewSession,
  onDuplicateSession,
  onOpenTerminal,
}: SessionPillProps) {
  const subAgentInfo = sessionSource ? parseSubAgentPath(sessionSource.fileName) : null
  const subAgentLabel = subAgentInfo ? formatAgentLabel(subAgentInfo.agentId) : null
  const thinkingEnabled = session.turns.some((turn) => turn.thinking.length > 0)
  const rawMessages = (
    session.agentKind === "codex" ? [] : session.rawMessages
  ) as readonly RawMessage[]

  return (
    <Tooltip>
      <TooltipTrigger
        delay={200}
        render={<div className={cn(FLOATING_PILL, "flex h-8 min-w-0 items-center gap-2 pl-1 pr-3")} />}
      >
        {sessionSource ? (
          <SessionBreadcrumb
            session={session}
            sessionSource={sessionSource}
            copied={copied}
            creatingSession={creatingSession}
            onCopyResume={onCopyResume}
            onNewSession={onNewSession}
            onDuplicateSession={onDuplicateSession}
            onOpenTerminal={onOpenTerminal}
          />
        ) : (
          <button
            type="button"
            onClick={onCopyResume}
            className="truncate rounded-full px-1.5 py-1 text-sm font-medium text-foreground"
          >
            {copied ? "Copied" : session.slug || session.sessionId.slice(0, 8)}
          </button>
        )}
        {isLive && <LiveIndicator aria-label="Session is live" />}
        {session.model && (
          <span className="shrink-0 font-mono text-[11px] text-foreground/80">
            {shortenModel(session.model)}
          </span>
        )}
        <ContextBadge rawMessages={rawMessages} />
      </TooltipTrigger>
      <TooltipContent role="tooltip" side="bottom" align="start" sideOffset={6} className="p-3">
        <SessionDetails
          session={session}
          thinkingEnabled={thinkingEnabled}
          subAgentLabel={subAgentLabel}
          pullRequests={pullRequests}
          rawMessages={rawMessages}
        />
      </TooltipContent>
    </Tooltip>
  )
})

interface SessionDetailsProps {
  session: ParsedSession
  thinkingEnabled: boolean
  subAgentLabel: string | null
  pullRequests: SessionPullRequest[]
  rawMessages: readonly RawMessage[]
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">{children}</span>
    </div>
  )
}

function SessionDetails({
  session,
  thinkingEnabled,
  subAgentLabel,
  pullRequests,
  rawMessages,
}: SessionDetailsProps) {
  const ctx = getContextUsage(rawMessages)
  const duplicatedFrom = session.branchedFrom

  return (
    <div className="flex min-w-64 max-w-96 flex-col gap-1.5 text-xs">
      {session.model && (
        <DetailRow label="Model">
          <span>{shortenModel(session.model)}</span>
          {thinkingEnabled && <span className="text-muted-foreground">· thinking</span>}
        </DetailRow>
      )}
      {session.gitBranch && (
        <DetailRow label="Branch">
          <span className="truncate font-mono">{session.gitBranch}</span>
        </DetailRow>
      )}
      {pullRequests.length > 0 && (
        <DetailRow label="Pull requests">
          <PullRequestChips pullRequests={pullRequests} />
        </DetailRow>
      )}
      {subAgentLabel && <DetailRow label="Agent">{subAgentLabel}</DetailRow>}
      {duplicatedFrom && (
        <DetailRow label="Duplicated from">
          {duplicatedFrom.sessionId.slice(0, 8)}
          {duplicatedFrom.turnIndex != null ? ` at turn ${duplicatedFrom.turnIndex + 1}` : ""}
        </DetailRow>
      )}
      {ctx && (
        <DetailRow label="Context">
          {formatTokenCount(Math.max(0, ctx.compactAt - ctx.used))} left before compact ·{" "}
          {formatTokenCount(ctx.used)} / {formatTokenCount(ctx.limit)}
        </DetailRow>
      )}
    </div>
  )
}

interface SessionBreadcrumbProps {
  session: ParsedSession
  sessionSource: SessionSource
  copied: boolean
  creatingSession: boolean
  onCopyResume: () => void
  onNewSession: (dirName: string, cwd?: string) => void
  onDuplicateSession?: () => void
  onOpenTerminal?: () => void
}

function SessionBreadcrumb({
  session,
  sessionSource,
  copied,
  creatingSession,
  onCopyResume,
  onNewSession,
  onDuplicateSession,
  onOpenTerminal,
}: SessionBreadcrumbProps) {
  const { dispatch } = useAppContext()
  const hasProject = Boolean(session.cwd || sessionSource.dirName)
  const isRemote = isRemoteDeviceActive()
  const sessionLabel = session.slug || session.sessionId.slice(0, 8)
  const breadcrumb = session.cwd ? `${projectName(session.cwd)} / ${sessionLabel}` : sessionLabel

  const project = { path: session.cwd, dirName: sessionSource.dirName }
  // The built-in workspace reads files over the device proxy, so it stays
  // available even when the session runs on another machine.
  const canOpenEditor = !isRemote || isBuiltInEditorEnabled()

  function handleViewProjectSessions(): void {
    startTransition(() => {
      dispatch({ type: "GO_HOME", isMobile: false })
      dispatch({ type: "SET_DASHBOARD_PROJECT", dirName: sessionSource.dirName })
    })
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={<button
          type="button"
          onClick={onCopyResume}
          className="flex min-w-0 max-w-80 items-center gap-1.5 truncate rounded-full px-1.5 py-1 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          aria-label={`Copy resume command for ${breadcrumb}; open session actions with the context menu`}
          aria-haspopup="menu"
          title="Click to copy resume command. Right-click for session actions."
        />}
      >
        {copied ? (
          <span className="flex items-center gap-1.5 text-success">
            <Check className="size-3" /> Copied
          </span>
        ) : (
          <>
            {session.cwd && <span className="truncate text-muted-foreground">{projectName(session.cwd)}</span>}
            {session.cwd && <span className="text-muted-foreground/50">/</span>}
            <span className="truncate">{sessionLabel}</span>
          </>
        )}
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-56">
        <ContextMenuItem
          disabled={creatingSession}
          onClick={() => onNewSession(sessionSource.dirName, session.cwd)}
        >
          {creatingSession ? <Spinner className="size-3.5" /> : <Plus className="size-3.5" />}
          New session in this project
        </ContextMenuItem>
        {onDuplicateSession && (
          <ContextMenuItem onClick={onDuplicateSession}>
            <Copy className="size-3.5" />
            Duplicate this session
          </ContextMenuItem>
        )}
        {hasProject && (canOpenEditor || !isRemote) && (
          <>
            <ContextMenuSeparator />
            {canOpenEditor && (
              <ContextMenuItem onClick={() => openProject(project)}>
                <Code2 className="size-3.5" />
                Open project in editor
              </ContextMenuItem>
            )}
            {!isRemote && (
              <ContextMenuItem onClick={() => revealInFolder(project)}>
                <FolderSearch className="size-3.5" />
                Reveal in file manager
              </ContextMenuItem>
            )}
          </>
        )}
        {onOpenTerminal && !isRemote && can("terminal") && (
          <ContextMenuItem onClick={onOpenTerminal}>
            <TerminalSquare className="size-3.5" />
            Open terminal in project
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={handleViewProjectSessions}>
          <FolderOpen className="size-3.5" />
          View all sessions in this project
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
