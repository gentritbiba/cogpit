import { memo, useMemo } from "react"
import { ContextMenu } from "@base-ui/react/context-menu"
import {
  BarChart3,
  Bot,
  Brain,
  Check,
  ChevronRight,
  Code2,
  Copy,
  Eye,
  FileCode2,
  FolderOpen,
  FolderSearch,
  GitBranch,
  Globe,
  PanelLeftClose,
  PanelRightClose,
  Plus,
  Search,
  Settings,
  Skull,
  SlidersHorizontal,
  TerminalSquare,
  Workflow as WorkflowIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/Spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { DeviceSwitcher } from "@/components/DeviceSwitcher"
import { LeakIndicator } from "@/components/LeakIndicator"
import { MissionControlButton } from "@/components/MissionControl/MissionControlButton"
import { NotificationsBell } from "@/components/NotificationsBell"
import { PowerMonitor } from "@/components/PowerMonitor"
import { PullRequestChips } from "@/components/PullRequestChips"
import { TokenUsageIndicator } from "@/components/TokenUsageWidget"
import { ContextBadge, HeaderIconButton, LiveIndicator } from "@/components/header-shared"
import { formatAgentLabel } from "@/components/timeline/agent-utils"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext } from "@/contexts/SessionContext"
import { useSessionInventoryOptional } from "@/contexts/SessionInventoryContext"
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback"
import type { SessionSource } from "@/hooks/useLiveSession"
import { authFetch } from "@/lib/auth"
import { can } from "@/lib/capabilities"
import { isRemoteDeviceActive } from "@/lib/device"
import { parseSubAgentPath, projectName, shortenModel } from "@/lib/format"
import { agentKindFromDirName, getResumeCommand } from "@/lib/sessionSource"
import type { ParsedSession, RawMessage } from "@/lib/types"
import { extractPullRequests, mergePullRequests } from "../../shared/session/prLinks"
import packageJson from "../../package.json"

const CONTEXT_MENU_ITEM_CLASS =
  "flex items-center gap-2 rounded px-2.5 py-1.5 text-sm text-foreground outline-none cursor-pointer data-highlighted:bg-elevation-2 data-disabled:cursor-not-allowed data-disabled:opacity-50"

interface DesktopHeaderProps {
  showSidebar: boolean
  showStats: boolean
  showWorktrees?: boolean
  showFileChanges?: boolean
  hasFileChanges?: boolean
  killing: boolean
  creatingSession: boolean
  onGoHome: () => void
  onNewSession: (dirName: string, cwd?: string) => void
  onDuplicateSession?: () => void
  onOpenTerminal?: () => void
  onBackToMain?: () => void
  onShowWorkflows?: () => void
  workflowCount?: number
  onToggleSidebar: () => void
  onToggleStats: () => void
  onToggleWorktrees?: () => void
  onToggleFileChanges?: () => void
  onKillAll: () => void
  onOpenSettings: () => void
  onOpenCommandPalette: () => void
  commandPaletteShortcut: string
  showConfig?: boolean
  onToggleConfig?: () => void
  showMission?: boolean
  onToggleMission?: () => void
}

export const DesktopHeader = memo(function DesktopHeader({
  showSidebar,
  showStats,
  showWorktrees,
  showFileChanges,
  hasFileChanges,
  killing,
  creatingSession,
  onGoHome,
  onNewSession,
  onDuplicateSession,
  onOpenTerminal,
  onBackToMain,
  onShowWorkflows,
  workflowCount,
  onToggleSidebar,
  onToggleStats,
  onToggleWorktrees,
  onToggleFileChanges,
  onKillAll,
  onOpenSettings,
  onOpenCommandPalette,
  commandPaletteShortcut,
  showConfig,
  onToggleConfig,
  showMission,
  onToggleMission,
}: DesktopHeaderProps) {
  const { config: { networkUrl, defaultAgentKind } } = useAppContext()
  const { session, sessionSource, isLive } = useSessionContext()
  const inventory = useSessionInventoryOptional()
  const sessionTurns = session?.turns
  const scanned = inventory?.sessions.find(
    (candidate) => candidate.sessionId === session?.sessionId,
  )?.pullRequests
  const pullRequests = useMemo(
    () => mergePullRequests(extractPullRequests(sessionTurns ?? []), scanned),
    [sessionTurns, scanned],
  )
  const activeAgentKind = sessionSource
    ? sessionSource.agentKind ?? agentKindFromDirName(sessionSource.dirName)
    : defaultAgentKind
  const subAgentInfo = sessionSource ? parseSubAgentPath(sessionSource.fileName) : null
  const subAgentLabel = subAgentInfo ? formatAgentLabel(subAgentInfo.agentId) : null
  const thinkingEnabled = session?.turns.some((turn) => turn.thinking.length > 0) ?? false
  const claudeRawMessages = (
    session?.agentKind === "codex" ? [] : session?.rawMessages ?? []
  ) as readonly RawMessage[]
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
    <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border/50 bg-elevation-2 px-2.5 electron-drag">
      <Tooltip>
        <TooltipTrigger render={<button
            type="button"
            onClick={onGoHome}
            className="shrink-0 transition-opacity hover:opacity-70"
            aria-label={session ? "Back to Dashboard" : "Cogpit"}
          />}>
            <Eye className="size-4 text-blue-400" />
        </TooltipTrigger>
        <TooltipContent>{session ? "Back to Dashboard" : "Cogpit"}</TooltipContent>
      </Tooltip>

      <span className="shrink-0 select-none font-mono text-[10px] text-muted-foreground/50">
        v{packageJson.version}
      </span>

      {session ? (
        <>
          {subAgentInfo && onBackToMain && (
            <button
              type="button"
              onClick={onBackToMain}
              className="inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[10px] font-medium text-blue-400 transition-colors hover:bg-blue-500/15"
            >
              <ChevronRight className="size-3 rotate-180" />
              Main
            </button>
          )}

          {sessionSource ? (
            <SessionBreadcrumb
              session={session}
              sessionSource={sessionSource}
              copied={cmdCopied}
              creatingSession={creatingSession}
              onCopyResume={handleCopyResumeCmd}
              onNewSession={onNewSession}
              onDuplicateSession={onDuplicateSession}
              onOpenTerminal={onOpenTerminal}
            />
          ) : (
            <button
              type="button"
              onClick={handleCopyResumeCmd}
              className="truncate text-sm font-medium text-foreground"
            >
              {session.slug || session.sessionId.slice(0, 8)}
            </button>
          )}

          {isLive && <LiveIndicator aria-label="Session is live" />}

          {subAgentLabel && (
            <Badge variant="outline" className="h-5 shrink-0 gap-1 border-indigo-500/30 bg-indigo-500/10 px-1.5 text-[10px] font-normal text-indigo-400">
              <Bot className="size-2.5" />
              Agent {subAgentLabel}
            </Badge>
          )}

          {session.branchedFrom && (
            <Tooltip>
              <TooltipTrigger render={<Badge variant="outline" className="h-5 shrink-0 gap-1 border-purple-700/50 bg-purple-500/5 px-1.5 text-[10px] font-normal text-purple-400" />}>
                  <Copy className="size-2.5" />
                  Duplicated
              </TooltipTrigger>
              <TooltipContent>
                Duplicated from {session.branchedFrom.sessionId.slice(0, 8)}
                {session.branchedFrom.turnIndex != null ? ` at turn ${session.branchedFrom.turnIndex + 1}` : ""}
              </TooltipContent>
            </Tooltip>
          )}

          <div className="flex min-w-0 shrink items-center gap-2 font-mono text-[11px]">
            {session.model && (
              <span className="shrink-0 text-foreground/80">{shortenModel(session.model)}</span>
            )}
            {thinkingEnabled && (
              <span className="flex shrink-0 items-center gap-1 text-purple-400">
                <Brain className="size-3" />
                thinking
              </span>
            )}
            {session.gitBranch && (
              <span className="max-w-40 truncate text-muted-foreground">{session.gitBranch}</span>
            )}
            <PullRequestChips pullRequests={pullRequests} />
          </div>

          <ContextBadge
            rawMessages={claudeRawMessages}
            showRemaining
            showTooltip
          />

          {onShowWorkflows && (workflowCount ?? 0) > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={onShowWorkflows}
            >
              <WorkflowIcon className="size-3" />
              Workflows
              <Badge variant="outline" className="h-4 min-w-4 justify-center px-1 text-[9px] font-semibold">
                {workflowCount}
              </Badge>
            </Button>
          )}
        </>
      ) : (
        <h1 className="text-sm font-semibold tracking-tight">Cogpit</h1>
      )}

      <div className="min-w-2 flex-1" />

      <TokenUsageIndicator agentKind={activeAgentKind} />

      <LeakIndicator />

      <NotificationsBell />

      <DeviceSwitcher />

      <NetworkStatus
        networkUrl={networkUrl}
        urlCopied={urlCopied}
        onCopyUrl={handleCopyNetworkUrl}
      />

      <div className="flex shrink-0 items-center gap-0.5">
        <PowerMonitor />
        <HeaderIconButton
          icon={Search}
          label={`Command palette (${commandPaletteShortcut})`}
          onClick={onOpenCommandPalette}
        />
        {onToggleMission && (
          <MissionControlButton active={showMission ?? false} onToggle={onToggleMission} />
        )}
        {onToggleConfig && (
          <HeaderIconButton
            icon={SlidersHorizontal}
            label={showConfig ? "Close Config Browser" : "Config Browser"}
            onClick={onToggleConfig}
            className={showConfig ? "bg-blue-500/20" : undefined}
            iconClassName={showConfig ? "text-blue-400" : undefined}
          />
        )}
        <HeaderIconButton
          icon={Settings}
          label="Settings"
          onClick={onOpenSettings}
        />
        {can("killAny") && (
          <HeaderIconButton
            icon={Skull}
            label="Kill all tracked agent processes"
            onClick={onKillAll}
            disabled={killing}
            className="hover:bg-red-500/10 hover:text-red-400"
            iconClassName={killing ? "text-red-400" : undefined}
          />
        )}
        {onToggleWorktrees && (
          <HeaderIconButton
            icon={GitBranch}
            label={showWorktrees ? "Hide Worktrees" : "Show Worktrees"}
            onClick={onToggleWorktrees}
            className={showWorktrees ? "text-foreground" : undefined}
          />
        )}
        {hasFileChanges && onToggleFileChanges && (
          <HeaderIconButton
            icon={FileCode2}
            label={showFileChanges ? "Hide File Changes" : "Show File Changes"}
            onClick={onToggleFileChanges}
            className={showFileChanges ? "text-amber-400" : undefined}
            iconClassName={showFileChanges ? "text-amber-400" : undefined}
          />
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

  function postAction(endpoint: "/api/open-in-editor" | "/api/reveal-in-folder"): void {
    authFetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: session.cwd || undefined, dirName: sessionSource.dirName }),
    })
  }

  function handleViewProjectSessions(): void {
    dispatch({ type: "GO_HOME", isMobile: false })
    dispatch({ type: "SET_DASHBOARD_PROJECT", dirName: sessionSource.dirName })
  }

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        render={<button
          type="button"
          onClick={onCopyResume}
          className="flex min-w-0 max-w-[320px] items-center gap-1.5 truncate rounded px-1 py-0.5 text-sm font-medium text-foreground transition-colors hover:bg-elevation-1"
          aria-label={`Copy resume command for ${breadcrumb}; open session actions with the context menu`}
          aria-haspopup="menu"
          title="Click to copy resume command. Right-click for session actions."
        />}
      >
        {copied ? (
          <span className="flex items-center gap-1.5 text-green-400">
            <Check className="size-3" /> Copied
          </span>
        ) : (
          <>
            {session.cwd && <span className="truncate text-muted-foreground">{projectName(session.cwd)}</span>}
            {session.cwd && <span className="text-muted-foreground/50">/</span>}
            <span className="truncate">{sessionLabel}</span>
          </>
        )}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-50">
          <ContextMenu.Popup className="min-w-56 rounded-lg border border-border/30 bg-elevation-3 p-1 depth-high">
            <ContextMenu.Item
              className={CONTEXT_MENU_ITEM_CLASS}
              disabled={creatingSession}
              onClick={() => onNewSession(sessionSource.dirName, session.cwd)}
            >
              {creatingSession ? <Spinner className="size-3.5" /> : <Plus className="size-3.5" />}
              New session in this project
            </ContextMenu.Item>
            {onDuplicateSession && (
              <ContextMenu.Item className={CONTEXT_MENU_ITEM_CLASS} onClick={onDuplicateSession}>
                <Copy className="size-3.5" />
                Duplicate this session
              </ContextMenu.Item>
            )}
            {hasProject && !isRemote && (
              <>
                <ContextMenu.Separator className="my-1 h-px bg-border" />
                <ContextMenu.Item
                  className={CONTEXT_MENU_ITEM_CLASS}
                  onClick={() => postAction("/api/open-in-editor")}
                >
                  <Code2 className="size-3.5" />
                  Open project in editor
                </ContextMenu.Item>
                <ContextMenu.Item
                  className={CONTEXT_MENU_ITEM_CLASS}
                  onClick={() => postAction("/api/reveal-in-folder")}
                >
                  <FolderSearch className="size-3.5" />
                  Reveal in file manager
                </ContextMenu.Item>
              </>
            )}
            {onOpenTerminal && !isRemote && can("terminal") && (
              <ContextMenu.Item className={CONTEXT_MENU_ITEM_CLASS} onClick={onOpenTerminal}>
                <TerminalSquare className="size-3.5" />
                Open terminal in project
              </ContextMenu.Item>
            )}
            <ContextMenu.Separator className="my-1 h-px bg-border" />
            <ContextMenu.Item className={CONTEXT_MENU_ITEM_CLASS} onClick={handleViewProjectSessions}>
              <FolderOpen className="size-3.5" />
              View all sessions in this project
            </ContextMenu.Item>
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}

interface NetworkStatusProps {
  networkUrl: string | null
  urlCopied: boolean
  onCopyUrl: () => void
}

/**
 * Network URL button. Network access being off is the safe default and renders
 * nothing; being reachable on the LAN is the state worth seeing.
 */
function NetworkStatus({ networkUrl, urlCopied, onCopyUrl }: NetworkStatusProps) {
  if (!networkUrl) return null

  return (
    <Tooltip>
      <TooltipTrigger render={<button
          type="button"
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
      <TooltipContent>Reachable on your network — click to copy the connection URL</TooltipContent>
    </Tooltip>
  )
}
