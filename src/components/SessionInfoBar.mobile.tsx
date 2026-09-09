import {
  ChevronLeft,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  FileCode2,
  MoreHorizontal,
  Plus,
  Search,
  Workflow as WorkflowIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import { Spinner } from "@/components/ui/Spinner"
import { DeviceSwitcher } from "@/components/DeviceSwitcher"
import { ContextBadge } from "@/components/header-shared"
import type { SessionSource } from "@/hooks/useLiveSession"
import { projectName } from "@/lib/format"
import type { ParsedSession, RawMessage } from "../../shared/session/types"

export interface SessionInfoBarProps {
  creatingSession: boolean
  onNewSession: (dirName: string, cwd?: string) => void
  onDuplicateSession?: () => void
  onBackToMain?: () => void
  onShowFileChanges?: () => void
  hasFileChanges?: boolean
  onShowWorkflows?: () => void
  workflowCount?: number
  onSearch?: () => void
  expandAll?: boolean
  onToggleExpandAll?: () => void
}

interface MobileSessionInfoBarProps extends SessionInfoBarProps {
  session: ParsedSession
  sessionSource: SessionSource | null
  isSubAgentView: boolean
  claudeRawMessages: readonly RawMessage[]
}

export function MobileSessionInfoBar({
  session,
  sessionSource,
  isSubAgentView,
  claudeRawMessages,
  creatingSession,
  onNewSession,
  onDuplicateSession,
  onBackToMain,
  onShowFileChanges,
  hasFileChanges,
  onShowWorkflows,
  workflowCount,
  onSearch,
  expandAll,
  onToggleExpandAll,
}: MobileSessionInfoBarProps) {
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
