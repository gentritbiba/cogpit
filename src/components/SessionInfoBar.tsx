import { forwardRef, memo } from "react"
import {
  FolderOpen,
  Plus,
  Copy,
  Code2,
  FolderSearch,
  TerminalSquare,
  Bot,
  ChevronLeft,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Separator } from "@/components/ui/separator"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip"
import { parseSubAgentPath, projectName } from "@/lib/format"
import { formatAgentLabel } from "@/components/timeline/agent-utils"
import { ContextBadge } from "@/components/header-shared"
import { authFetch } from "@/lib/auth"
import { can } from "@/lib/capabilities"
import { isRemoteDeviceActive } from "@/lib/device"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext } from "@/contexts/SessionContext"
import { Spinner } from "@/components/ui/Spinner"
import { DeviceSwitcher } from "@/components/DeviceSwitcher"
import { SessionStatusBar } from "@/components/SessionStatusBar"
import type { RawMessage } from "@/lib/types"

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
      <header className="flex h-12 shrink-0 items-center gap-1.5 border-b bg-background px-2">
        {isSubAgentView && onBackToMain && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onBackToMain}
            aria-label="Back to main agent"
          >
            <ChevronLeft data-icon="inline-start" />
          </Button>
        )}

        <DeviceSwitcher compact />
        <Separator orientation="vertical" className="h-4" />
        <ContextBadge rawMessages={claudeRawMessages} warnOnly />

        <span className="min-w-0 flex-1 truncate text-center text-xs font-medium text-muted-foreground">
          {session.cwd ? projectName(session.cwd) : "Session"}
        </span>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={(
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Session actions"
              />
            )}
          >
            <MoreHorizontal data-icon="inline-start" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={6} className="w-72">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="flex flex-col gap-0.5">
                <span className="truncate text-foreground">
                  {session.cwd ? projectName(session.cwd) : "Current session"}
                </span>
                <span className="truncate font-normal">
                  {[session.model, session.gitBranch].filter(Boolean).join(" · ") || "Session actions"}
                </span>
              </DropdownMenuLabel>

              {sessionSource && (
                <DropdownMenuItem onClick={handleNewSession} disabled={creatingSession}>
                  {creatingSession ? <Spinner /> : <Plus />}
                  <span>New session</span>
                </DropdownMenuItem>
              )}
              {onDuplicateSession && (
                <DropdownMenuItem onClick={onDuplicateSession}>
                  <Copy />
                  <span>Duplicate session</span>
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {onSearch && (
                <DropdownMenuItem onClick={onSearch}>
                  <Search />
                  <span>Search conversation</span>
                </DropdownMenuItem>
              )}
              {onToggleExpandAll && (
                <DropdownMenuItem onClick={onToggleExpandAll}>
                  {expandAll ? <ChevronsDownUp /> : <ChevronsUpDown />}
                  <span>{expandAll ? "Collapse tool calls" : "Expand tool calls"}</span>
                </DropdownMenuItem>
              )}
              {hasFileChanges && onShowFileChanges && (
                <DropdownMenuItem onClick={onShowFileChanges}>
                  <FileCode2 />
                  <span>File changes</span>
                </DropdownMenuItem>
              )}
              {onShowWorkflows && (workflowCount ?? 0) > 0 && (
                <DropdownMenuItem onClick={onShowWorkflows}>
                  <WorkflowIcon />
                  <span className="flex-1">Workflows</span>
                  <Badge variant="secondary">{workflowCount}</Badge>
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
    )
  }

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b bg-background px-3">
      {isSubAgentView && (
        <>
          {onBackToMain && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={onBackToMain}
            >
              <ChevronLeft data-icon="inline-start" />
              Main
            </Button>
          )}
          <Badge variant="secondary">
            <Bot data-icon="inline-start" />
            Agent {subAgentLabel}
          </Badge>
        </>
      )}

      {session.branchedFrom && (
        <Tooltip>
          <TooltipTrigger render={<Badge variant="outline" />}>
              <Copy data-icon="inline-start" />
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

      <SessionStatusBar
        session={session}
        thinkingEnabled={session.turns.some((turn) => turn.thinking.length > 0)}
      />

      <div className="flex-1" />

      {sessionSource && (
        <SessionActions
          creatingSession={creatingSession}
          onNewSession={onNewSession}
          onDuplicateSession={onDuplicateSession}
          onOpenTerminal={onOpenTerminal}
          onShowWorkflows={onShowWorkflows}
          workflowCount={workflowCount}
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
  onShowWorkflows?: () => void
  workflowCount?: number
}

/** Action buttons shown in the desktop session info bar. */
function SessionActions({
  creatingSession,
  onNewSession,
  onDuplicateSession,
  onOpenTerminal,
  onShowWorkflows,
  workflowCount,
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
    <div className="flex items-center gap-1">
      <Button
        variant="outline"
        size="xs"
        onClick={handleNewSession}
        disabled={creatingSession}
      >
        {creatingSession ? <HeaderSpinnerIcon data-icon="inline-start" /> : <Plus data-icon="inline-start" />}
        New
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-xs" aria-label="More session actions" />}
        >
          <MoreHorizontal data-icon="inline-start" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Session</DropdownMenuLabel>
            {onDuplicateSession && (
              <DropdownMenuItem onClick={onDuplicateSession}>
                <Copy />
                Duplicate
              </DropdownMenuItem>
            )}
            {onShowWorkflows && (workflowCount ?? 0) > 0 && (
              <DropdownMenuItem onClick={onShowWorkflows}>
                <WorkflowIcon />
                <span className="flex-1">Workflows</span>
                <Badge variant="secondary">{workflowCount}</Badge>
              </DropdownMenuItem>
            )}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            {hasProject && !isRemoteDeviceActive() && (
              <>
                <DropdownMenuItem onClick={() => postAction("/api/open-in-editor")}>
                  <Code2 />
                  Open in editor
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => postAction("/api/reveal-in-folder")}>
                  <FolderSearch />
                  Reveal in file manager
                </DropdownMenuItem>
              </>
            )}
            {onOpenTerminal && !isRemoteDeviceActive() && can("terminal") && (
              <DropdownMenuItem onClick={onOpenTerminal}>
                <TerminalSquare />
                Open terminal
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={() => {
                const dirName = sessionSrc.dirName
                dispatch({ type: "GO_HOME", isMobile: false })
                dispatch({ type: "SET_DASHBOARD_PROJECT", dirName })
              }}
            >
              <FolderOpen />
              View project sessions
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
