import { useId, useMemo, useState, type MouseEvent } from "react"
import { ChevronDown, ChevronRight, ChevronUp, Loader2, Plus } from "lucide-react"

import { ProjectContextMenu } from "@/components/ProjectContextMenu"
import type { PendingSessionInfo } from "@/components/session-browser/types"
import { dirNameToPath, parseWorktreePath } from "@/lib/format"
import { cn } from "@/lib/utils"

import { SessionRow } from "./SessionRow"
import { countLiveSessions } from "./liveSessionSummary"
import { visibleRowCount } from "./sessionListView"
import type { ActiveSessionInfo, RunningProcess } from "./types"

interface ProjectGroupSharedProps {
  activeSessionKey: string | null
  procBySession: Map<string, RunningProcess>
  killingPids: Set<number>
  newlyCompleted: Set<string>
  sessionNames: Record<string, string>
  projectNames: Record<string, string>
  onToggleCollapsed: (key: string, collapsed: boolean) => void
  onSelectSession: (dirName: string, fileName: string) => void
  onKill: (pid: number, event: MouseEvent) => void
  onDuplicateSession?: (dirName: string, fileName: string) => void
  onDeleteSession?: (session: ActiveSessionInfo) => void
  onRenameSession?: (sessionId: string, name: string) => void
  onRenameProject?: (dirName: string, name: string) => void
  onNewSession?: (dirName: string, cwd?: string) => void
  creatingSession?: boolean
  onPrefetchSession?: (dirName: string, fileName: string) => void
  onResumeSession?: (sessionId: string, cwd?: string) => void
}

interface ProjectGroupListProps extends ProjectGroupSharedProps {
  grouped: Map<string, ActiveSessionInfo[]>
  pendingProjectPath: string | null
  pendingSession?: PendingSessionInfo | null
  collapsedGroups: Record<string, boolean>
  searchQuery: string
}

interface ProjectGroupProps extends ProjectGroupSharedProps {
  projectPath: string
  sessions: ActiveSessionInfo[]
  liveCount: number
  collapsed: boolean
  forceExpand?: boolean
  pendingSession?: PendingSessionInfo | null
}

export function ProjectGroupList({
  grouped,
  pendingProjectPath,
  pendingSession,
  collapsedGroups,
  searchQuery,
  activeSessionKey,
  procBySession,
  killingPids,
  newlyCompleted,
  sessionNames,
  projectNames,
  onToggleCollapsed,
  onSelectSession,
  onKill,
  onDuplicateSession,
  onDeleteSession,
  onRenameSession,
  onRenameProject,
  onNewSession,
  creatingSession,
  onPrefetchSession,
  onResumeSession,
}: ProjectGroupListProps) {
  const sharedProps: ProjectGroupSharedProps = {
    activeSessionKey,
    procBySession,
    killingPids,
    newlyCompleted,
    sessionNames,
    projectNames,
    onToggleCollapsed,
    onSelectSession,
    onKill,
    onDuplicateSession,
    onDeleteSession,
    onRenameSession,
    onRenameProject,
    onNewSession,
    creatingSession,
    onPrefetchSession,
    onResumeSession,
  }
  const forceExpand = Boolean(searchQuery.trim())

  return (
    <>
      {[...grouped.entries()].map(([projectPath, sessions], index) => {
        const liveCount = countLiveSessions(sessions, procBySession)
        return (
          <ProjectGroup
            {...sharedProps}
            key={projectPath}
            projectPath={projectPath}
            sessions={sessions}
            liveCount={liveCount}
            collapsed={collapsedGroups[projectPath] ?? (index >= 3 && liveCount === 0)}
            forceExpand={forceExpand}
            pendingSession={pendingProjectPath === projectPath ? pendingSession : undefined}
          />
        )
      })}

      {pendingProjectPath && !grouped.has(pendingProjectPath) && pendingSession && (
        <ProjectGroup
          {...sharedProps}
          key={`pending-${pendingProjectPath}`}
          projectPath={pendingProjectPath}
          sessions={[]}
          liveCount={0}
          collapsed={false}
          pendingSession={pendingSession}
        />
      )}
    </>
  )
}

function ProjectGroup({
  projectPath,
  sessions,
  activeSessionKey,
  procBySession,
  killingPids,
  newlyCompleted,
  sessionNames,
  projectNames,
  liveCount,
  collapsed,
  onToggleCollapsed,
  forceExpand = false,
  onSelectSession,
  onKill,
  onDuplicateSession,
  onDeleteSession,
  onRenameSession,
  onRenameProject,
  onNewSession,
  creatingSession,
  pendingSession,
  onPrefetchSession,
  onResumeSession,
}: ProjectGroupProps) {
  const sessionGroupId = useId()
  const hasPending = Boolean(pendingSession)
  const isCollapsed = forceExpand || hasPending ? false : collapsed

  const { topLevelSessions, teammatesByLead } = useMemo(() => {
    const ids = new Set(sessions.map((session) => session.sessionId))
    const teammatesByLead = new Map<string, ActiveSessionInfo[]>()
    const topLevelSessions: ActiveSessionInfo[] = []
    for (const session of sessions) {
      const lead = session.teamLeadSessionId
      if (lead && lead !== session.sessionId && ids.has(lead)) {
        const teammates = teammatesByLead.get(lead)
        if (teammates) teammates.push(session)
        else teammatesByLead.set(lead, [session])
      } else {
        topLevelSessions.push(session)
      }
    }
    return { topLevelSessions, teammatesByLead }
  }, [sessions])

  const [collapsedTeams, setCollapsedTeams] = useState<Set<string>>(new Set())
  const toggleTeamCollapse = (leadId: string) => {
    setCollapsedTeams((previous) => {
      const next = new Set(previous)
      if (next.has(leadId)) next.delete(leadId)
      else next.add(leadId)
      return next
    })
  }

  const visibleCount = 5
  const [showAll, setShowAll] = useState(false)
  const totalCount = sessions.length + (hasPending ? 1 : 0)
  const collapsedLimit = visibleRowCount(
    topLevelSessions,
    procBySession,
    Math.max(1, visibleCount - (hasPending ? 1 : 0)),
  )
  const expandRows = forceExpand || showAll
  const visibleTopLevel = expandRows
    ? topLevelSessions
    : topLevelSessions.slice(0, collapsedLimit)
  const hiddenCount = topLevelSessions.length - visibleTopLevel.length
  const canShowLess = showAll && !forceExpand && topLevelSessions.length > collapsedLimit

  const dirName = sessions.find((session) => (
    !parseWorktreePath(session.cwd ?? dirNameToPath(session.dirName))
  ))?.dirName ?? sessions[0]?.dirName ?? pendingSession?.dirName
  const customProjectName = dirName ? projectNames[dirName] : undefined

  function renderSessionRow(
    session: ActiveSessionInfo,
    worktreeName?: string,
    teamToggle?: { count: number; collapsed: boolean; onToggle: () => void },
  ) {
    return (
      <SessionRow
        key={`${session.dirName}/${session.fileName}`}
        session={session}
        isActiveSession={activeSessionKey === `${session.dirName}/${session.fileName}`}
        proc={procBySession.get(session.sessionId)}
        killingPids={killingPids}
        isNewlyCompleted={newlyCompleted.has(session.sessionId)}
        customName={sessionNames[session.sessionId]}
        worktreeName={worktreeName}
        teammateCount={teamToggle?.count}
        teammatesCollapsed={teamToggle?.collapsed}
        onToggleTeammates={teamToggle?.onToggle}
        onSelectSession={onSelectSession}
        onKill={onKill}
        onDuplicateSession={onDuplicateSession}
        onDeleteSession={onDeleteSession}
        onRenameSession={onRenameSession}
        onPrefetchSession={onPrefetchSession}
        onResumeSession={onResumeSession}
      />
    )
  }

  return (
    <div className="flex flex-col">
      <ProjectContextMenu
        projectLabel={projectPath}
        customName={customProjectName}
        className="sticky top-0 z-20 elevation-1"
        onRename={(name) => {
          if (dirName && onRenameProject) onRenameProject(dirName, name)
        }}
      >
        <div className="flex items-center gap-1 px-1.5 pt-2 pb-0.5 w-full">
          <button
            type="button"
            onClick={() => onToggleCollapsed(projectPath, !collapsed)}
            disabled={forceExpand}
            aria-expanded={!isCollapsed}
            aria-controls={sessionGroupId}
            title={forceExpand ? "Groups stay expanded while searching" : undefined}
            className="flex items-center gap-1 flex-1 min-w-0 text-left hover:bg-white/[0.02] rounded-sm transition-colors"
          >
            <ChevronRight className={cn(
              "size-2.5 text-muted-foreground/50 transition-transform duration-150 shrink-0",
              !isCollapsed && "rotate-90",
            )} />
            <span className="text-[11px] font-medium text-muted-foreground/70 truncate">
              {customProjectName || projectPath}
            </span>
            {customProjectName && (
              <span className="text-[10px] text-muted-foreground/40 truncate">
                {projectPath}
              </span>
            )}
            {liveCount > 0 && (
              <span
                className="flex items-center gap-1 shrink-0 text-[10px] font-medium text-green-400"
                aria-label={`${liveCount} live sessions`}
              >
                <span className="size-1.5 rounded-full bg-green-400 animate-pulse" aria-hidden="true" />
                {liveCount}
              </span>
            )}
            <span className="text-[10px] text-muted-foreground/40 shrink-0">
              {totalCount}
            </span>
          </button>
          {onNewSession && sessions.length > 0 && (
            <button
              type="button"
              className="shrink-0 rounded p-0.5 text-muted-foreground/50 hover:text-foreground hover:bg-white/[0.05] transition-colors"
              disabled={creatingSession}
              onClick={(event) => {
                event.stopPropagation()
                const first = sessions[0]
                onNewSession(first.dirName, first.cwd ?? undefined)
              }}
              aria-label={`New session in ${projectPath}`}
            >
              {creatingSession ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Plus className="size-3" />
              )}
            </button>
          )}
        </div>
      </ProjectContextMenu>

      {!isCollapsed && (
        <div
          id={sessionGroupId}
          className="flex flex-col gap-px ml-2.5 border-l border-border/40 pl-1"
        >
          {pendingSession && (
            <PendingSessionRow firstMessage={pendingSession.firstMessage} />
          )}
          {visibleTopLevel.map((session) => {
            const rawPath = session.cwd ?? dirNameToPath(session.dirName)
            const worktree = parseWorktreePath(rawPath)
            const teammates = teammatesByLead.get(session.sessionId)
            if (!teammates) return renderSessionRow(session, worktree?.worktreeName)

            const teamCollapsed = collapsedTeams.has(session.sessionId)
            return (
              <div key={`${session.dirName}/${session.fileName}`} className="flex flex-col gap-px">
                {renderSessionRow(session, worktree?.worktreeName, {
                  count: teammates.length,
                  collapsed: teamCollapsed,
                  onToggle: () => toggleTeamCollapse(session.sessionId),
                })}
                {!teamCollapsed && (
                  <div className="flex flex-col gap-px ml-3 border-l border-violet-500/30 pl-1">
                    {teammates.map((teammate) => renderSessionRow(teammate))}
                  </div>
                )}
              </div>
            )
          })}
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-left text-[11px] text-muted-foreground/60 hover:text-foreground hover:bg-white/[0.03] transition-colors"
            >
              <ChevronDown className="size-2.5" />
              Show {hiddenCount} more
            </button>
          )}
          {canShowLess && (
            <button
              type="button"
              onClick={() => setShowAll(false)}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-left text-[11px] text-muted-foreground/60 hover:text-foreground hover:bg-white/[0.03] transition-colors"
            >
              <ChevronUp className="size-2.5" />
              Show less
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function PendingSessionRow({ firstMessage }: { firstMessage?: string }) {
  return (
    <div className="relative w-full flex items-center gap-1.5 rounded-r-md px-2 py-1 text-left border-l-2 border-l-blue-500 rounded-l-none">
      <Loader2 className="size-2.5 animate-spin text-blue-400 shrink-0" />
      <span className="text-xs leading-tight truncate flex-1 text-foreground">
        {firstMessage || "New session"}
      </span>
    </div>
  )
}
