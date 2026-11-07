import { Fragment, useCallback, useMemo, useState, type MouseEvent } from "react"
import { History, Loader2 } from "lucide-react"

import type { PendingSessionInfo } from "@/components/session-browser/types"
import { Button } from "@/components/ui/button"
import { deviceScopedKey } from "@/lib/device"
import { dirNameToPath, parseWorktreePath } from "@/lib/format"
import { revealSessionById } from "@/lib/revealSession"
import { useListedPermissions } from "@/hooks/useListedPermissions"
import { useLocalStorage } from "@/hooks/useLocalStorage"
import { sortSessionsByRecency } from "../../../shared/session-ordering"

import { countCrew, crewActivityAt, crewSessionTitle, foldCrewRows, type MemberStatus } from "./crew"
import { recencyBucket } from "./recencyBuckets"
import { SessionCard, type CardCrew, type CardLineage } from "./SessionCard"
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
  /** Fold each crew under the session that started it; off lists every session on its own. */
  groupCrews?: boolean
  /** Every listed session, to name a member's parent and root when they are not in this list. */
  lineageSessions?: readonly ActiveSessionInfo[]
  /** What a crew member is doing. */
  memberStatusOf?: (member: ActiveSessionInfo) => MemberStatus
}

const DONE: MemberStatus = { state: "done" }

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
  groupCrews = true,
  lineageSessions,
  memberStatusOf = () => DONE,
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
  const permissionsOf = useListedPermissions()
  // Shelf labels come out of the same memo as the ordering they describe. A
  // session carrying a crew is placed by the crew's latest activity.
  const ordered = useMemo(() => {
    const folded = groupCrews ? foldCrewRows(sessions) : { topLevel: sessions, crewOf: new Map<string, ActiveSessionInfo[]>() }
    const split = splitTeammates(folded.topLevel)
    const activityAt = (s: ActiveSessionInfo) => {
      const members = folded.crewOf.get(s.sessionId)
      return members ? crewActivityAt(s, members) : s.lastActivityAt || s.lastModified
    }
    const placed = new Map(split.topLevelSessions.map((s) => [{ ...s, lastActivityAt: activityAt(s) }, s]))
    const topLevelSessions = sortSessionsByRecency([...placed.keys()]).map((key) => placed.get(key)!)
    const now = Date.now()
    const buckets = topLevelSessions.map((s) => recencyBucket(activityAt(s), now))
    return { topLevelSessions, teammatesByLead: split.teammatesByLead, crewOf: folded.crewOf, buckets }
  }, [sessions, groupCrews])
  // While the pointer is over the list its order holds still; rows still update in place.
  const [frozen, setFrozen] = useState<FrozenOrder | null>(null)
  const { shown, shelves } = useMemo(
    () => placeRows(ordered.topLevelSessions, ordered.buckets, frozen),
    [ordered, frozen],
  )
  const [openCrews, setOpenCrews] = useLocalStorage<string[]>(deviceScopedKey("live-sessions-open-crews"), [])
  const { teammatesByLead, crewOf } = ordered
  const openCrewIds = useMemo(() => new Set(Array.isArray(openCrews) ? openCrews : []), [openCrews])
  const toggleCrew = useCallback((rootId: string) => {
    setOpenCrews((current) => {
      const open = Array.isArray(current) ? current : []
      return open.includes(rootId) ? open.filter((id) => id !== rootId) : [...open, rootId]
    })
  }, [setOpenCrews])
  const knownById = useMemo(
    () => new Map([...(lineageSessions ?? []), ...sessions].map((s) => [s.sessionId, s])),
    [lineageSessions, sessions],
  )
  const [collapsedTeams, setCollapsedTeams] = useState<Set<string>>(new Set())
  const toggleTeam = useCallback((leadId: string) => {
    setCollapsedTeams((previous) => {
      const next = new Set(previous)
      if (next.has(leadId)) next.delete(leadId)
      else next.add(leadId)
      return next
    })
  }, [])

  const rowProps = (session: ActiveSessionInfo): SessionRowProps => {
    const permissions = permissionsOf(session.access)
    return {
      session,
      isActiveSession: activeSessionKey === sessionKey(session),
      proc: procBySession.get(session.sessionId),
      killingPids,
      isNewlyCompleted: newlyCompleted.has(session.sessionId),
      customName: sessionNames[session.sessionId],
      onSelectSession,
      onKill: permissions.stop ? onKill : undefined,
      onDuplicateSession,
      onDeleteSession: permissions.delete ? onDeleteSession : undefined,
      onArchiveSession: permissions.archive ? onArchiveSession : undefined,
      onUnarchiveSession: permissions.archive ? onUnarchiveSession : undefined,
      onRenameSession,
      onPrefetchSession,
      onResumeSession: permissions.send ? onResumeSession : undefined,
    }
  }

  return (
    <div
      className="flex flex-col gap-1.5"
      data-session-card-list
      onPointerEnter={() => setFrozen(freezeOrder(ordered.topLevelSessions, ordered.buckets))}
      onPointerLeave={() => setFrozen(null)}
    >
      {pendingSession && <PendingSessionRow firstMessage={pendingSession.firstMessage} />}
      {shown.map((session, index) => {
        const key = sessionKey(session)
        const path = session.cwd ?? dirNameToPath(session.dirName)
        const worktree = parseWorktreePath(path)
        const projectLabel = projectNames[session.dirName] ?? sessionGroupKey(session)
        const teammates = teammatesByLead.get(session.sessionId)
        const collapsed = collapsedTeams.has(session.sessionId)
        const shelf = shelves[index]
        const members = crewOf.get(session.sessionId)
        const crew: CardCrew | undefined = members && {
          members,
          counts: countCrew(members, memberStatusOf),
          statusOf: memberStatusOf,
          activityAt: crewActivityAt(session, members),
          open: openCrewIds.has(session.sessionId),
          onToggle: () => toggleCrew(session.sessionId),
        }
        // Cards are memoized: only a crew card needs the open session and the names its members show.
        const card = (
          <SessionCard
            {...rowProps(session)}
            worktreeName={worktree?.worktreeName}
            projectLabel={projectLabel}
            projectPath={worktree?.parentPath ?? path}
            showProject={showProject}
            teammateCount={teammates?.length}
            teammatesCollapsed={teammates ? collapsed : undefined}
            onToggleTeammates={teammates ? toggleTeam : undefined}
            crew={crew}
            lineage={lineageOf(session, knownById, sessionNames, onSelectSession)}
            sessionNames={crew ? sessionNames : undefined}
            activeSessionKey={crew ? activeSessionKey : undefined}
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

/** For a crew member listed on its own: who started it, and the crew's root when that is someone else. */
function lineageOf(
  session: ActiveSessionInfo,
  knownById: ReadonlyMap<string, ActiveSessionInfo>,
  sessionNames: Record<string, string>,
  onSelectSession: (dirName: string, fileName: string) => void,
): CardLineage | undefined {
  const crew = session.crew
  if (!crew) return undefined
  const parentTitle = crewSessionTitle(crew.parentId, knownById, sessionNames) ?? crew.parentTitle ?? "Another session"
  const rootTitle = crew.rootId === crew.parentId
    ? undefined
    : crewSessionTitle(crew.rootId, knownById, sessionNames) ?? crew.rootTitle
  const parent = knownById.get(crew.parentId)
  return {
    parentTitle,
    ...(rootTitle && rootTitle !== parentTitle && { rootTitle }),
    onOpenParent: parent
      ? () => onSelectSession(parent.dirName, parent.fileName)
      : () => void revealSessionById(crew.parentId),
  }
}

interface FrozenOrder {
  keys: string[]
  bucketOf: Map<string, string>
}

function freezeOrder(sessions: readonly ActiveSessionInfo[], buckets: readonly string[]): FrozenOrder {
  const keys = sessions.map(sessionKey)
  return { keys, bucketOf: new Map(keys.map((key, index) => [key, buckets[index]])) }
}

/**
 * The rows in their display order with the shelf label each one opens. Frozen,
 * rows keep the order and shelf they had when the pointer arrived, and rows
 * that joined since wait at the end.
 */
function placeRows(
  sessions: readonly ActiveSessionInfo[],
  buckets: readonly string[],
  frozen: FrozenOrder | null,
): { shown: ActiveSessionInfo[]; shelves: Array<string | null> } {
  let shown: ActiveSessionInfo[] = [...sessions]
  let shownBuckets: string[] = [...buckets]
  if (frozen) {
    const byKey = new Map(sessions.map((session, index) => [sessionKey(session), index]))
    const held = frozen.keys.filter((key) => byKey.has(key))
    const heldKeys = new Set(held)
    const joined = sessions.map((_, index) => index).filter((index) => !heldKeys.has(sessionKey(sessions[index])))
    shown = [...held.map((key) => sessions[byKey.get(key)!]), ...joined.map((index) => sessions[index])]
    shownBuckets = [...held.map((key) => frozen.bucketOf.get(key)!), ...joined.map((index) => buckets[index])]
  }
  const shelves = shownBuckets.map((bucket, i) => (bucket === shownBuckets[i - 1] ? null : bucket))
  return { shown, shelves }
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
