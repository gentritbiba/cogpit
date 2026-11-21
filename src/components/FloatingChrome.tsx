import { memo, useMemo, useState, type ComponentProps } from "react"
import type { LucideIcon } from "lucide-react"
import { ChevronRight, PanelLeftOpen, Workflow as WorkflowIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { CrewParentPill } from "@/components/CrewParentPill"
import { SessionTitle } from "@/components/SessionTitle"
import { ShareButton } from "@/components/ShareButton"
import { sessionHeadline, isUntitledSession } from "@/components/LiveSessions/sessionListView"
import { useOpenSession, useSessionControls } from "@/contexts/SessionContext"
import { useSessionInventoryOptional } from "@/contexts/SessionInventoryContext"
import { useEditionUi } from "@/edition/hooks"
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback"
import { useInboxSync } from "@/hooks/useInboxSync"
import { useSessionArchiveToggle } from "@/hooks/useSessionArchive"
import { useSessionNames } from "@/hooks/useSessionNames"
import { useStopSession } from "@/hooks/useStopSession"
import { can } from "@/lib/capabilities"
import { parseSubAgentPath } from "@/lib/format"
import { agentKindForDirName, capabilitiesFor, getResumeCommand } from "@/lib/agents"
import { cn } from "@/lib/utils"
import { extractPullRequests, mergePullRequests, type SessionPullRequest } from "../../shared/session/prLinks"

type OpenSessionTitleProps = Omit<ComponentProps<typeof SessionTitle>, "session" | "pullRequests" | "onStopSession"> & {
  scannedPullRequests: SessionPullRequest[] | undefined
}

/** The title's menu shows the session as it streams; the chrome around it does not re-render with it. */
function OpenSessionTitle({ scannedPullRequests, ...title }: OpenSessionTitleProps) {
  const session = useOpenSession((open) => open)
  const onStopSession = useStopSession()
  const turns = session?.turns
  const pullRequests = useMemo(
    () => mergePullRequests(extractPullRequests(turns ?? []), scannedPullRequests),
    [turns, scannedPullRequests],
  )
  return session && <SessionTitle session={session} pullRequests={pullRequests} onStopSession={onStopSession} {...title} />
}

interface FloatingChromeProps {
  /** Whether the sidebar is toggled on — decides if the expand button is offered. */
  showSidebar: boolean
  /**
   * Whether a sidebar is actually on screen. Config view replaces it with its
   * own rail, and without a sidebar the title has to clear the traffic lights
   * itself.
   */
  sidebarRendered?: boolean
  sidebarShortcut: string
  creatingSession: boolean
  onNewSession: (dirName: string, cwd?: string) => void
  onDuplicateSession?: () => void
  onOpenTerminal?: () => void
  onBackToMain?: () => void
  onShowWorkflows?: () => void
  workflowCount?: number
  onToggleSidebar: () => void
  /** Receives the element the sticky prompt renders into, between the title and the session's actions. */
  promptSlotRef?: (element: HTMLElement | null) => void
  /** Off on views that are not the conversation, where the open session's line would describe something else. */
  showSession?: boolean
}

/**
 * The one line above the conversation: the session's title, which is also its
 * menu, and beside it only what the session is doing right now (the session
 * that started it, running workflows, an open share). Everything about the app
 * lives in the rail. Content scrolls underneath; the pane reserves its own top
 * padding.
 */
export const FloatingChrome = memo(function FloatingChrome({
  showSidebar,
  sidebarRendered = showSidebar,
  sidebarShortcut,
  creatingSession,
  onNewSession,
  onDuplicateSession,
  onOpenTerminal,
  onBackToMain,
  onShowWorkflows,
  workflowCount,
  onToggleSidebar,
  promptSlotRef,
  showSession = true,
}: FloatingChromeProps) {
  const { sessionSource, isLive, permissions, actions } = useSessionControls()
  const openId = useOpenSession((open) => open?.sessionId ?? null)
  const sessionId = showSession ? openId : null
  const sessionCwd = useOpenSession((open) => open?.cwd)
  const sessionSlug = useOpenSession((open) => open?.slug)
  const inventory = useSessionInventoryOptional()
  const { names: sessionNames } = useSessionNames()
  const { SessionHeaderActions } = useEditionUi()
  useInboxSync()
  const [shareOpen, setShareOpen] = useState(false)
  const [cmdCopied, copyCmd] = useCopyWithFeedback()

  const listed = inventory?.sessions.find(
    (candidate) => candidate.sessionId === sessionId,
  )
  const archiveToggle = useSessionArchiveToggle(sessionId ?? "", isLive, permissions.archive)
  const isSubAgent = sessionSource ? parseSubAgentPath(sessionSource.fileName) !== null : false
  const agentKind = sessionSource?.agentKind ?? agentKindForDirName(sessionSource?.dirName ?? null)
  const canShare = capabilitiesFor(agentKind).sharing && can("share")
  const customName = sessionId !== null ? sessionNames[sessionId] : undefined
  const title = sessionId !== null && (listed && !isUntitledSession(listed, customName)
    ? sessionHeadline(listed, customName)
    : customName || sessionSlug || sessionId.slice(0, 8))

  function handleCopyResumeCmd(): void {
    if (sessionId === null) return
    copyCmd(getResumeCommand(agentKind, sessionId, sessionCwd))
  }

  return (
    <>
      {/* Stands in for the removed title bar. It ships with the title so the
          two always share a stacking context: the session view nests the
          chrome inside a resizable panel, where a pane-owned strip would paint
          over the title and swallow its clicks. */}
      <div aria-hidden className="drag-strip absolute inset-x-0 top-0 z-10 h-10" />
      {/* Content scrolls under the title, so it has to fade out rather than
          collide with it. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 z-20 h-16 bg-gradient-to-b from-background from-50% to-transparent"
      />
      <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex items-start justify-between gap-3 px-2 pt-2">
        <div
          className={cn(
            "electron-no-drag pointer-events-auto flex min-w-0 shrink-0 items-center gap-1 max-w-[70%]",
            !sidebarRendered && "window-inset-start",
          )}
        >
          {!showSidebar && (
            <ChromeIconButton
              icon={PanelLeftOpen}
              label={`Show sidebar (${sidebarShortcut})`}
              onClick={onToggleSidebar}
            />
          )}

          {sessionId !== null && isSubAgent && onBackToMain && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={onBackToMain}
              className="h-8 shrink-0 rounded-lg px-2 text-xs text-muted-foreground"
            >
              <ChevronRight className="size-3 rotate-180" />
              Main
            </Button>
          )}

          {title && (
            <OpenSessionTitle
              sessionSource={sessionSource}
              title={title}
              isLive={isLive}
              scannedPullRequests={listed?.pullRequests}
              copied={cmdCopied}
              creatingSession={creatingSession}
              onCopyResume={handleCopyResumeCmd}
              onNewSession={onNewSession}
              onDuplicateSession={onDuplicateSession}
              onOpenTerminal={onOpenTerminal}
              onShare={canShare ? () => setShareOpen(true) : undefined}
              onHandoff={!isSubAgent && permissions.send ? actions.handleProviderHandoff : undefined}
              archive={isSubAgent ? null : archiveToggle}
            />
          )}

          {sessionId !== null && !isSubAgent && <CrewParentPill sessionId={sessionId} />}

          {sessionId !== null && onShowWorkflows && (workflowCount ?? 0) > 0 && (
            <Button
              variant="ghost"
              size="xs"
              className="h-8 shrink-0 gap-1 rounded-lg px-2 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={onShowWorkflows}
            >
              <WorkflowIcon className="size-3" />
              Workflows
              <Badge variant="outline" className="h-4 min-w-4 justify-center px-1 text-[9px] font-semibold">
                {workflowCount}
              </Badge>
            </Button>
          )}
        </div>

        <div
          ref={promptSlotRef}
          className="electron-no-drag pointer-events-auto flex min-w-0 flex-1 justify-end overflow-hidden empty:pointer-events-none"
        />

        <div className="electron-no-drag window-inset-end pointer-events-auto flex shrink-0 items-center gap-1 empty:hidden">
          {sessionId !== null && canShare && (
            <ShareButton sessionId={sessionId} open={shareOpen} onOpenChange={setShareOpen} />
          )}
          {sessionId !== null && !isSubAgent && SessionHeaderActions && (
            <SessionHeaderActions sessionId={sessionId} />
          )}
        </div>
      </div>
    </>
  )
})

function ChromeIconButton({ icon: Icon, label, onClick }: {
  icon: LucideIcon
  label: string
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClick}
            aria-label={label}
            className="size-8 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
          />
        }
      >
        <Icon data-icon="inline-start" />
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}
