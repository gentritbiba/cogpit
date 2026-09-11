import { Fragment, useMemo, useState, type MouseEvent } from "react"
import { History, Loader2 } from "lucide-react"

import type { PendingSessionInfo } from "@/components/session-browser/types"
import { Button } from "@/components/ui/button"
import { dirNameToPath, parseWorktreePath } from "@/lib/format"
import { sortSessionsByRecency } from "../../../shared/session-ordering"

import { recencyBucket } from "./recencyBuckets"
import { SessionCard } from "./SessionCard"
import { SessionRow, type SessionRowProps } from "./SessionRow"
import { sessionGroupKey, splitTeammates } from "./sessionListView"
import type { ActiveSessionInfo, RunningProcess } from "./types"

/** What the sidebar list needs to render and act on a session. */
export interface SessionListSharedProps {
  activeSessionKey: string | null
  procBySession: Map<string, RunningProcess>
  killingPids: Set<number>
  newlyCompleted: Set<string>
  sessionNames: Record<string, string>
  projectNames: Record<string, string>
  onSelectSession: (dirName: string, fileName: string) => void
  onKill?: (pid: number, event: MouseEvent) => void
  onDuplicateSession?: (dirName: string, fileName: string) => void
  onDeleteSession?: (session: ActiveSessionInfo) => void
  onArchiveSession?: (session: ActiveSessionInfo) => void
  onUnarchiveSession?: (session: ActiveSessionInfo) => void
  onRenameSession?: (sessionId: string, name: string) => void
  onPrefetchSession?: (dirName: string, fileName: string) => void
  onResumeSession?: (sessionId: string, cwd: string | undefined, dirName: string) => void
}

type SessionCardListProps = SessionListSharedProps & {
  sessions: ActiveSessionInfo[]
  pendingSession?: PendingSessionInfo | null
  older: { canLoad: boolean; loading: boolean; load: () => void }
  /** Name each card's project; on when the list mixes projects. */
  showProject?: boolean
}

/**
 * The sidebar's session list: one flat run of cards, newest first, shelved
 * by day ("Today", "Yesterday", ...) so a long run keeps its bearings, with
 * teammates nested under their lead as rows. The same list serves every
 * project and a focused one; only the sessions handed in differ.
 */
export function SessionCardList({
  sessions,
  pendingSession,
  older,
  showProject,
  activeSessionKey,
  procBySession,
  killingPids,
  newlyCompleted,
  sessionNames,
  projectNames,
  onSelectSession,
  onKill,
  onDuplicateSession,
  onDeleteSession,
  onArchiveSession,
  onUnarchiveSession,
  onRenameSession,
  onPrefetchSession,
  onResumeSession,
}: SessionCardListProps) {
  // Shelf labels come out of the same memo as the ordering they describe.
  const { topLevelSessions, teammatesByLead, shelves } = useMemo(() => {
    const split = splitTeammates(sessions)
    const topLevelSessions = sortSessionsByRecency(split.topLevelSessions)
    const now = Date.now()
    const buckets = topLevelSessions.map((s) => recencyBucket(s.lastActivityAt || s.lastModified, now))
    const shelves = buckets.map((bucket, i) => (bucket === buckets[i - 1] ? null : bucket))
    return { topLevelSessions, teammatesByLead: split.teammatesByLead, shelves }
  }, [sessions])
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
    <div className="flex flex-col gap-1.5" data-session-card-list>
      {pendingSession && <PendingSessionRow firstMessage={pendingSession.firstMessage} />}
      {topLevelSessions.map((session, index) => {
        const key = sessionKey(session)
        const path = session.cwd ?? dirNameToPath(session.dirName)
        const worktree = parseWorktreePath(path)
        const projectLabel = projectNames[session.dirName] ?? sessionGroupKey(session)
        const teammates = teammatesByLead.get(session.sessionId)
        const collapsed = collapsedTeams.has(session.sessionId)
        const shelf = shelves[index]
        const card = (
          <SessionCard
            {...rowProps(session)}
            worktreeName={worktree?.worktreeName}
            projectLabel={projectLabel}
            projectPath={worktree?.parentPath ?? path}
            showProject={showProject}
            teammateCount={teammates?.length}
            teammatesCollapsed={teammates ? collapsed : undefined}
            onToggleTeammates={teammates ? () => toggleTeam(session.sessionId) : undefined}
          />
        )
        return (
          <Fragment key={key}>
            {shelf && <RecencyDivider label={shelf} />}
            {teammates && !collapsed ? (
              <div className="flex flex-col gap-px">
                {card}
                <div className="ml-3 flex flex-col gap-px border-l pl-1">
                  {teammates.map((teammate) => (
                    <SessionRow key={sessionKey(teammate)} {...rowProps(teammate)} />
                  ))}
                </div>
              </div>
            ) : card}
          </Fragment>
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

function RecencyDivider({ label }: { label: string }) {
  return (
    <div
      data-recency-divider
      className="px-1 pb-0.5 pt-2 text-[11px] font-medium text-muted-foreground/80 first:pt-0"
    >
      {label}
    </div>
  )
}

function PendingSessionRow({ firstMessage }: { firstMessage?: string }) {
  return (
    <div className="motion-enter relative flex w-full items-center gap-1.5 rounded-lg border border-border/70 bg-accent px-3 py-2.5 text-left">
      <Loader2 className="size-3 shrink-0 animate-spin text-info" />
      <span className="flex-1 truncate text-sm leading-tight text-foreground">
        {firstMessage || "New session"}
      </span>
    </div>
  )
}

function sessionKey(session: ActiveSessionInfo): string {
  return `${session.dirName}/${session.fileName}`
}
