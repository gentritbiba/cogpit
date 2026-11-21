import { memo } from "react"
import type { ReactNode } from "react"
import {
  ArrowRightLeft,
  Check,
  ChevronDown,
  ClipboardCopy,
  Code2,
  Copy,
  FolderOpen,
  FolderSearch,
  Plus,
  Power,
  Share2,
  TerminalSquare,
} from "lucide-react"
import { Spinner } from "@/components/ui/Spinner"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { PullRequestChips } from "@/components/PullRequestChips"
import { LiveIndicator, sessionContextUsage } from "@/components/header-shared"
import { formatAgentLabel } from "@/components/timeline/agent-utils"
import { useAppContext } from "@/contexts/AppContext"
import type { SessionSource } from "@/lib/sessionSource"
import type { SessionArchiveToggle } from "@/hooks/useSessionArchive"
import { can } from "@/lib/capabilities"
import { isRemoteDeviceActive } from "@/lib/device"
import { isBuiltInEditorEnabled, openProject, revealInFolder } from "@/lib/fileOpener"
import {
  formatTokenCount,
  parseSubAgentPath,
  projectName,
  shortenModel,
} from "@/lib/format"
import type { SessionView } from "../../shared/session/sessionDigest"
import type { ContextUsage } from "../../shared/session/contextWindow"
import type { SessionPullRequest } from "../../shared/session/prLinks"

interface SessionTitleProps {
  session: SessionView
  sessionSource: SessionSource | null
  /** What the session is called everywhere else; its slug or id when it has no title. */
  title: string
  isLive: boolean
  pullRequests: SessionPullRequest[]
  copied: boolean
  creatingSession: boolean
  onCopyResume: () => void
  onNewSession: (dirName: string, cwd?: string) => void
  onDuplicateSession?: () => void
  onOpenTerminal?: () => void
  /** Absent where the session cannot be shared. */
  onShare?: () => void
  onHandoff?: () => void
  archive?: SessionArchiveToggle | null
  /** Absent while there is no running process to stop. */
  onStopSession?: () => void
}

/**
 * `project / title` as the one thing above the conversation. It opens the
 * session's menu: its state first (model, branch, pull requests, context),
 * then everything that can be done to the session and its project.
 */
export const SessionTitle = memo(function SessionTitle({
  session,
  sessionSource,
  title,
  isLive,
  pullRequests,
  copied,
  creatingSession,
  onCopyResume,
  onNewSession,
  onDuplicateSession,
  onOpenTerminal,
  onShare,
  onHandoff,
  archive,
  onStopSession,
}: SessionTitleProps) {
  const { dispatch } = useAppContext()
  const subAgentInfo = sessionSource ? parseSubAgentPath(sessionSource.fileName) : null
  const subAgentLabel = subAgentInfo ? formatAgentLabel(subAgentInfo.agentId) : null
  const thinkingEnabled = session.turns.some((turn) => turn.thinking.length > 0)
  const contextUsage = sessionContextUsage(session, sessionSource?.dirName)

  const isRemote = isRemoteDeviceActive()
  const project = sessionSource ? { path: session.cwd, dirName: sessionSource.dirName } : null
  // Both reach the host's own files, which an edition may keep to some accounts.
  const hostFiles = can("hostFiles")
  // The built-in workspace reads files over the device proxy, so it stays
  // available even when the session runs on another machine.
  const canOpenEditor = hostFiles && (!isRemote || isBuiltInEditorEnabled())
  const canReveal = hostFiles && !isRemote
  const projectLabel = session.cwd ? projectName(session.cwd) : null

  function handleViewProjectSessions(): void {
    if (!sessionSource) return
    dispatch({ type: "GO_HOME", isMobile: false })
    dispatch({ type: "SET_DASHBOARD_PROJECT", dirName: sessionSource.dirName })
  }

  return (
    <div className="flex h-8 min-w-0 items-center gap-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<button
            type="button"
            className="flex h-8 min-w-0 max-w-[32rem] items-center gap-1.5 rounded-lg px-2 text-sm text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent"
            aria-label={`${projectLabel ? `${projectLabel} / ` : ""}${title}. Session menu`}
          />}
        >
          {isLive && <LiveIndicator className="size-1.5" aria-label="Session is live" />}
          {copied ? (
            <span className="flex items-center gap-1.5 text-success">
              <Check className="size-3" /> Copied
            </span>
          ) : (
            <>
              {projectLabel && <span className="shrink-0 text-muted-foreground">{projectLabel}</span>}
              {projectLabel && <span className="text-muted-foreground/50">/</span>}
              <span className="truncate font-medium">{title}</span>
            </>
          )}
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={6} className="w-80">
          <SessionDetails
            session={session}
            thinkingEnabled={thinkingEnabled}
            subAgentLabel={subAgentLabel}
            pullRequests={pullRequests}
            contextUsage={contextUsage}
          />
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={onCopyResume}>
              <ClipboardCopy />
              Copy resume command
            </DropdownMenuItem>
            {onDuplicateSession && (
              <DropdownMenuItem onClick={onDuplicateSession}>
                <Copy />
                Duplicate this session
              </DropdownMenuItem>
            )}
            {onShare && (
              <DropdownMenuItem onClick={onShare}>
                <Share2 />
                Share session…
              </DropdownMenuItem>
            )}
            {onHandoff && (
              <DropdownMenuItem onClick={onHandoff}>
                <ArrowRightLeft />
                Continue with another provider…
              </DropdownMenuItem>
            )}
            {archive && (
              <DropdownMenuItem
                onClick={archive.toggle}
                disabled={Boolean(archive.disabledReason)}
                title={archive.disabledReason}
              >
                <archive.icon />
                {archive.label}
              </DropdownMenuItem>
            )}
          </DropdownMenuGroup>
          {sessionSource && project && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem
                  disabled={creatingSession}
                  onClick={() => onNewSession(sessionSource.dirName, session.cwd)}
                >
                  {creatingSession ? <Spinner className="size-3.5" /> : <Plus />}
                  New session in this project
                </DropdownMenuItem>
                {canOpenEditor && (
                  <DropdownMenuItem onClick={() => openProject(project)}>
                    <Code2 />
                    Open project in editor
                  </DropdownMenuItem>
                )}
                {canReveal && (
                  <DropdownMenuItem onClick={() => revealInFolder(project)}>
                    <FolderSearch />
                    Reveal in file manager
                  </DropdownMenuItem>
                )}
                {onOpenTerminal && !isRemote && can("terminal") && (
                  <DropdownMenuItem onClick={onOpenTerminal}>
                    <TerminalSquare />
                    Open terminal in project
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={handleViewProjectSessions}>
                  <FolderOpen />
                  View all sessions in this project
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </>
          )}
          {onStopSession && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem variant="destructive" onClick={onStopSession}>
                  <Power />
                  Stop session
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
})

interface SessionDetailsProps {
  session: SessionView
  thinkingEnabled: boolean
  subAgentLabel: string | null
  pullRequests: SessionPullRequest[]
  contextUsage: ContextUsage | null
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">{children}</span>
    </div>
  )
}

/** The session's state, at the top of its menu. Nothing when there is none to report. */
function SessionDetails({
  session,
  thinkingEnabled,
  subAgentLabel,
  pullRequests,
  contextUsage: ctx,
}: SessionDetailsProps) {
  const duplicatedFrom = session.branchedFrom
  if (!session.model && !session.gitBranch && pullRequests.length === 0 && !subAgentLabel && !duplicatedFrom && !ctx) {
    return null
  }

  return (
    <>
      <div data-session-details className="flex flex-col gap-1.5 px-2 py-1.5 text-xs">
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
      <DropdownMenuSeparator />
    </>
  )
}
