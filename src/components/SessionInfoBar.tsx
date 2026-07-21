import { forwardRef, memo } from "react"
import { Menu } from "@base-ui/react/menu"
import {
  FolderOpen,
  Plus,
  Copy,
  Code2,
  FolderSearch,
  TerminalSquare,
  Bot,
  ChevronRight,
  FileCode2,
  Workflow as WorkflowIcon,
  MoreHorizontal,
  Search,
  ChevronsDownUp,
  ChevronsUpDown,
  type LucideProps,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip"
import { parseSubAgentPath, projectName } from "@/lib/format"
import { formatAgentLabel } from "@/components/timeline/agent-utils"
import { ContextBadge, HeaderIconButton } from "@/components/header-shared"
import { authFetch } from "@/lib/auth"
import { isRemoteDeviceActive } from "@/lib/device"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext } from "@/contexts/SessionContext"
import { Spinner } from "@/components/ui/Spinner"
import { DeviceSwitcher } from "@/components/DeviceSwitcher"
import type { RawMessage } from "@/lib/types"

const MOBILE_MENU_ITEM_CLASS =
  "flex min-h-10 w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-xs text-foreground outline-none transition-colors data-highlighted:bg-elevation-2"

const HeaderSpinnerIcon = forwardRef<SVGSVGElement, LucideProps>(function HeaderSpinnerIcon(
  props,
  ref,
) {
  return <Spinner ref={ref} {...props} />
})

interface SessionInfoBarProps {
  creatingSession: boolean
  onNewSession: (dirName: string, cwd?: string) => void
  onDuplicateSession?: () => void
  onOpenTerminal?: () => void
  onBackToMain?: () => void
  onShowFileChanges?: () => void
  hasFileChanges?: boolean
  onShowWorkflows?: () => void
  workflowCount?: number
  onSearch?: () => void
  expandAll?: boolean
  onToggleExpandAll?: () => void
}

export const SessionInfoBar = memo(function SessionInfoBar({
  creatingSession,
  onNewSession,
  onDuplicateSession,
  onOpenTerminal,
  onBackToMain,
  onShowFileChanges,
  hasFileChanges,
  onShowWorkflows,
  workflowCount,
  onSearch,
  expandAll,
  onToggleExpandAll,
}: SessionInfoBarProps) {
  const { isMobile } = useAppContext()
  const { session: sessionOrNull, sessionSource } = useSessionContext()
  const session = sessionOrNull!
  const subAgentInfo = sessionSource ? parseSubAgentPath(sessionSource.fileName) : null
  const isSubAgentView = subAgentInfo !== null
  const subAgentLabel = subAgentInfo ? formatAgentLabel(subAgentInfo.agentId) : null
  const claudeRawMessages = (
    session.agentKind === "codex" ? [] : session.rawMessages
  ) as readonly RawMessage[]

  if (isMobile) {
    const handleNewSession = () => {
      if (!sessionSource) return
      onNewSession(sessionSource.dirName, session.cwd)
    }

    return (
      <header className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border/40 bg-elevation-1 px-1.5">
        {isSubAgentView && onBackToMain && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-10"
            onClick={onBackToMain}
            aria-label="Back to main agent"
          >
            <ChevronRight className="rotate-180" />
          </Button>
        )}

        <DeviceSwitcher compact />
        <span className="h-4 w-px shrink-0 bg-border/40" aria-hidden="true" />
        <ContextBadge rawMessages={claudeRawMessages} warnOnly />

        <span className="min-w-0 flex-1 truncate text-center text-[11px] font-medium text-muted-foreground">
          {session.cwd ? projectName(session.cwd) : "Session"}
        </span>

        <Menu.Root>
          <Menu.Trigger
            render={(
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-10"
                aria-label="Session actions"
              />
            )}
          >
            <MoreHorizontal />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner sideOffset={6} align="end" className="z-50">
              <Menu.Popup className="min-w-64 rounded-xl border border-border/40 bg-elevation-3 p-1.5 depth-high">
                <div className="px-2.5 pb-2 pt-1">
                  <p className="truncate text-xs font-medium text-foreground">
                    {session.cwd ? projectName(session.cwd) : "Current session"}
                  </p>
                  <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                    {[session.model, session.gitBranch].filter(Boolean).join(" · ") || "Session actions"}
                  </p>
                </div>

                {sessionSource && (
                  <Menu.Item className={MOBILE_MENU_ITEM_CLASS} onClick={handleNewSession} disabled={creatingSession}>
                    {creatingSession ? <Spinner className="size-4" /> : <Plus className="size-4" />}
                    <span>New session</span>
                  </Menu.Item>
                )}
                {onDuplicateSession && (
                  <Menu.Item className={MOBILE_MENU_ITEM_CLASS} onClick={onDuplicateSession}>
                    <Copy className="size-4" />
                    <span>Duplicate session</span>
                  </Menu.Item>
                )}
                {onSearch && (
                  <Menu.Item className={MOBILE_MENU_ITEM_CLASS} onClick={onSearch}>
                    <Search className="size-4" />
                    <span>Search conversation</span>
                  </Menu.Item>
                )}
                {onToggleExpandAll && (
                  <Menu.Item className={MOBILE_MENU_ITEM_CLASS} onClick={onToggleExpandAll}>
                    {expandAll ? <ChevronsDownUp className="size-4" /> : <ChevronsUpDown className="size-4" />}
                    <span>{expandAll ? "Collapse tool calls" : "Expand tool calls"}</span>
                  </Menu.Item>
                )}
                {hasFileChanges && onShowFileChanges && (
                  <Menu.Item className={MOBILE_MENU_ITEM_CLASS} onClick={onShowFileChanges}>
                    <FileCode2 className="size-4" />
                    <span>File changes</span>
                  </Menu.Item>
                )}
                {onShowWorkflows && (workflowCount ?? 0) > 0 && (
                  <Menu.Item className={MOBILE_MENU_ITEM_CLASS} onClick={onShowWorkflows}>
                    <WorkflowIcon className="size-4" />
                    <span className="flex-1">Workflows</span>
                    <Badge variant="outline">{workflowCount}</Badge>
                  </Menu.Item>
                )}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </header>
    )
  }

  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/50 bg-elevation-1 px-3">
      {/* Sub-agent navigation */}
      {isSubAgentView && (
        <>
          {onBackToMain && (
            <button
              type="button"
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

      {session.branchedFrom && (
        <Tooltip>
          <TooltipTrigger render={<Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal text-purple-400 border-purple-700/50 bg-purple-500/5 gap-1" />}>
              <Copy className="size-2.5" />
              Duplicated
          </TooltipTrigger>
          <TooltipContent>
            Duplicated from {session.branchedFrom.sessionId.slice(0, 8)}
            {session.branchedFrom.turnIndex != null ? ` at turn ${session.branchedFrom.turnIndex + 1}` : ""}
          </TooltipContent>
        </Tooltip>
      )}

      <ContextBadge
        rawMessages={claudeRawMessages}
        showRemaining
        showTooltip={!isMobile}
      />

      <div className="flex-1" />

      {/* Project name */}
      {session.cwd && (
        <span className="text-[11px] font-medium text-muted-foreground">
          {projectName(session.cwd)}
        </span>
      )}

      <div className="flex-1" />

      {/* Workflows button */}
      {onShowWorkflows && (workflowCount ?? 0) > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 gap-1 text-[11px] text-muted-foreground hover:text-violet-400 hover:bg-violet-500/20"
          onClick={onShowWorkflows}
        >
          <WorkflowIcon className="size-3" />
          Workflows
          <Badge variant="outline" className="h-4 min-w-4 justify-center px-1 text-[9px] font-semibold border-violet-700/50 text-violet-300">
            {workflowCount}
          </Badge>
        </Button>
      )}

      {/* Action buttons */}
      {sessionSource && (
        <SessionActions
          creatingSession={creatingSession}
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
  creatingSession: boolean
  onNewSession: (dirName: string, cwd?: string) => void
  onDuplicateSession?: () => void
  onOpenTerminal?: () => void
}

/** Action buttons shown in the desktop session info bar. */
function SessionActions({
  creatingSession,
  onNewSession,
  onDuplicateSession,
  onOpenTerminal,
}: SessionActionsProps): React.ReactNode {
  const { dispatch } = useAppContext()
  const { session: sessionOrNull, sessionSource } = useSessionContext()
  const session = sessionOrNull!
  const sessionSrc = sessionSource!
  const hasProject = !!(session.cwd || sessionSrc.dirName)

  /** POST path + dirName to an action endpoint (fire-and-forget). */
  function postAction(endpoint: string): void {
    authFetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: session.cwd || undefined, dirName: sessionSrc.dirName }),
    })
  }

  function handleNewSession(): void {
    onNewSession(sessionSrc.dirName, session.cwd)
  }

  return (
    <>
      <HeaderIconButton
        icon={creatingSession ? HeaderSpinnerIcon : Plus}
        label="New session in this project"
        onClick={handleNewSession}
        disabled={creatingSession}
        className="text-muted-foreground hover:text-green-400 hover:bg-green-500/20"
        // Spinner ignores animate-spin, so we can leave it or remove it. Leaving it is fine.
      />
      {onDuplicateSession && (
        <HeaderIconButton
          icon={Copy}
          label="Duplicate this session"
          onClick={onDuplicateSession}
          className="text-muted-foreground hover:text-purple-400 hover:bg-purple-500/20"
        />
      )}
      {hasProject && !isRemoteDeviceActive() && (
        <>
          <HeaderIconButton
            icon={Code2}
            label="Open project in editor"
            onClick={() => postAction("/api/open-in-editor")}
            className="text-muted-foreground hover:text-blue-400 hover:bg-blue-500/20"
          />
          <HeaderIconButton
            icon={FolderSearch}
            label="Reveal in file manager"
            onClick={() => postAction("/api/reveal-in-folder")}
            className="text-zinc-500 hover:text-amber-400 hover:bg-amber-500/10"
          />
        </>
      )}
      {onOpenTerminal && !isRemoteDeviceActive() && (
        <HeaderIconButton
          icon={TerminalSquare}
          label="Open terminal in project"
          onClick={onOpenTerminal}
          className="text-muted-foreground hover:text-emerald-400 hover:bg-emerald-500/20"
        />
      )}
      <HeaderIconButton
        icon={FolderOpen}
        label="View all sessions in this project"
        onClick={() => {
          const dirName = sessionSrc.dirName
          dispatch({ type: "GO_HOME", isMobile: false })
          dispatch({ type: "SET_DASHBOARD_PROJECT", dirName })
        }}
        className="text-muted-foreground hover:text-foreground"
      />
    </>
  )
}
