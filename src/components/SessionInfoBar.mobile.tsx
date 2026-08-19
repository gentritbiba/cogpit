import { Menu } from "@base-ui/react/menu"
import {
  ChevronRight,
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
import { Spinner } from "@/components/ui/Spinner"
import { DeviceSwitcher } from "@/components/DeviceSwitcher"
import { ContextBadge } from "@/components/header-shared"
import { projectName } from "@/lib/format"
import type { SessionSource } from "@/hooks/useLiveSession"
import type { ParsedSession, RawMessage } from "@/lib/types"

const MOBILE_MENU_ITEM_CLASS =
  "flex min-h-10 w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-xs text-foreground outline-none transition-colors data-highlighted:bg-elevation-2"

export interface SessionInfoBarProps {
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
