import { useMemo, useState } from "react"
import { History, Loader2 } from "lucide-react"

import type { PendingSessionInfo } from "@/components/session-browser/types"
import { Button } from "@/components/ui/button"
import { dirNameToPath, parseWorktreePath } from "@/lib/format"

import { PendingSessionRow, type ProjectGroupSharedProps } from "./ProjectGroupList"
import { SessionCard } from "./SessionCard"
import { SessionRow, type SessionRowProps } from "./SessionRow"
import { splitTeammates } from "./sessionListView"
import type { ActiveSessionInfo } from "./types"

/** What both sidebar lists need to render and act on a session, focused or not. */
export type SessionListSharedProps = Pick<
  ProjectGroupSharedProps,
  | "activeSessionKey"
  | "procBySession"
  | "killingPids"
  | "newlyCompleted"
  | "sessionNames"
  | "onSelectSession"
  | "onKill"
  | "onDuplicateSession"
  | "onDeleteSession"
  | "onArchiveSession"
  | "onUnarchiveSession"
  | "onRenameSession"
  | "onPrefetchSession"
  | "onResumeSession"
>

type FocusedProjectListProps = SessionListSharedProps & {
  sessions: ActiveSessionInfo[]
  pendingSession?: PendingSessionInfo | null
  older: { canLoad: boolean; loading: boolean; load: () => void }
}

/** One project's sessions as cards, teammates nested under their lead as rows. */
export function FocusedProjectList({
  sessions,
  pendingSession,
  older,
  activeSessionKey,
  procBySession,
  killingPids,
  newlyCompleted,
  sessionNames,
  onSelectSession,
  onKill,
  onDuplicateSession,
  onDeleteSession,
  onArchiveSession,
  onUnarchiveSession,
  onRenameSession,
  onPrefetchSession,
  onResumeSession,
}: FocusedProjectListProps) {
  const { topLevelSessions, teammatesByLead } = useMemo(() => splitTeammates(sessions), [sessions])
  const [collapsedTeams, setCollapsedTeams] = useState<Set<string>>(new Set())
  const toggleTeam = (leadId: string) => {
    setCollapsedTeams((previous) => {
      const next = new Set(previous)
      if (next.has(leadId)) next.delete(leadId)
      else next.add(leadId)
      return next
    })
  }

  const rowProps = (session: ActiveSessionInfo): SessionRowProps => ({
    session,
    isActiveSession: activeSessionKey === sessionKey(session),
    proc: procBySession.get(session.sessionId),
    killingPids,
    isNewlyCompleted: newlyCompleted.has(session.sessionId),
    customName: sessionNames[session.sessionId],
    onSelectSession,
    onKill,
    onDuplicateSession,
    onDeleteSession,
    onArchiveSession,
    onUnarchiveSession,
    onRenameSession,
    onPrefetchSession,
    onResumeSession,
  })

  return (
    <div className="flex flex-col gap-1.5" data-focused-project-list>
      {pendingSession && <PendingSessionRow firstMessage={pendingSession.firstMessage} />}
      {topLevelSessions.map((session) => {
        const key = sessionKey(session)
        const worktree = parseWorktreePath(session.cwd ?? dirNameToPath(session.dirName))
        const teammates = teammatesByLead.get(session.sessionId)
        if (!teammates) {
          return <SessionCard key={key} {...rowProps(session)} worktreeName={worktree?.worktreeName} />
        }
        const collapsed = collapsedTeams.has(session.sessionId)
        return (
          <div key={key} className="flex flex-col gap-px">
            <SessionCard
              {...rowProps(session)}
              worktreeName={worktree?.worktreeName}
              teammateCount={teammates.length}
              teammatesCollapsed={collapsed}
              onToggleTeammates={() => toggleTeam(session.sessionId)}
            />
            {!collapsed && (
              <div className="ml-3 flex flex-col gap-px border-l pl-1">
                {teammates.map((teammate) => (
                  <SessionRow key={sessionKey(teammate)} {...rowProps(teammate)} />
                ))}
              </div>
            )}
          </div>
        )
      })}
      {older.canLoad && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={older.load}
          disabled={older.loading}
          className="justify-start text-muted-foreground"
        >
          {older.loading
            ? <Loader2 data-icon="inline-start" className="animate-spin" />
            : <History data-icon="inline-start" />}
          Load older sessions
        </Button>
      )}
    </div>
  )
}

function sessionKey(session: ActiveSessionInfo): string {
  return `${session.dirName}/${session.fileName}`
}
