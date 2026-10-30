import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react"
import { ChevronDown, ChevronLeft, ChevronRight, FolderOpen, Pencil, Search, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Empty, EmptyHeader, EmptyDescription } from "@/components/ui/empty"
import { memberStatus, type CrewPendingInput, type MemberState } from "@/components/LiveSessions/crew"
import { crewSessionTitle } from "@/components/LiveSessions/crew"
import { STATUS_DOT } from "@/components/LiveSessions/statusDot"
import { sessionGroupKey, sessionTitle } from "@/components/LiveSessions/sessionListView"
import type { ActiveSessionInfo } from "@/components/LiveSessions/types"
import { usePendingHumanInput } from "@/contexts/PendingHumanInputContext"
import { useSessionInventory } from "@/contexts/SessionInventoryContext"
import { useListedPermissions } from "@/hooks/useListedPermissions"
import { useProjectNames } from "@/hooks/useProjectNames"
import { useSessionNames } from "@/hooks/useSessionNames"
import { agentKindForDirName, projectDirNameFor } from "@/lib/agents"
import { formatRelativeTime, parseWorktreePath, projectName } from "@/lib/format"
import { revealSessionById } from "@/lib/revealSession"
import { cn } from "@/lib/utils"
import { HomeComposer, type HomeProject, type HomeStart } from "./HomeComposer"
import { HomeRequestPrompt } from "./HomeRequestPrompt"
import { homeQueue, homeRequestId, homeSessionRows, homeSessions, recentHomeProjects, searchHomeSessions, type HomeRequest, type HomeSession } from "./homeView"

const MEMBER_DOT: Record<MemberState, string> = {
  "needs-you": STATUS_DOT.attention,
  working: STATUS_DOT.working,
  done: "bg-muted-foreground/40",
}
const MEMBER_STATE: Record<MemberState, string> = { "needs-you": "needs you", working: "working", done: "done" }
/** How many working or waiting members a collapsed crew names. */
const CREW_CHIPS = 3

export interface MissionHomeProps {
  onOpenSession: (dirName: string, fileName: string) => void
  /** The full list of projects and their history. */
  onBrowseProjects?: () => void
  /** Starting a session from the home; without it the composer stays hidden. */
  start?: HomeStart
}

/**
 * Where the composer offers to start: the project of the session the user
 * worked in last. A session in a worktree suggests the checkout it belongs to,
 * the way the session rows fold worktrees into their project.
 */
function suggestedProject(latest: ActiveSessionInfo, projectNames: Record<string, string>): HomeProject {
  const worktree = latest.cwd ? parseWorktreePath(latest.cwd) : null
  const cwd = worktree?.parentPath ?? latest.cwd
  const dirName = worktree ? projectDirNameFor(agentKindForDirName(latest.dirName), worktree.parentPath) : latest.dirName
  return { dirName, cwd, name: projectNames[dirName] ?? (cwd ? projectName(cwd) : latest.projectShortName) }
}

/** Typing in a field or holding a modifier is never a page shortcut. */
function isShortcutTarget(event: globalThis.KeyboardEvent): boolean {
  const editing = event.target instanceof HTMLElement && event.target.closest("input,textarea,select,[contenteditable=true]")
  return !event.metaKey && !event.ctrlKey && !event.altKey && !editing
}

/**
 * The first screen: where the next piece of work starts; what is blocked on
 * the user, across every session and crew, answerable one request at a time;
 * and the sessions the user started, each with its crew, searchable across
 * all of them. The composer and search stay put; only the lists scroll, and
 * the queue takes a column only while something is waiting.
 */
export function MissionHome({ onOpenSession, onBrowseProjects, start }: MissionHomeProps) {
  const inventory = useSessionInventory()
  const input = usePendingHumanInput()
  const { names, rename } = useSessionNames()
  const { names: projectNames } = useProjectNames()
  const permissionsOf = useListedPermissions()
  const [query, setQuery] = useState("")
  const searchRef = useRef<HTMLInputElement>(null)
  const sessions = useMemo(() => inventory.sessions.filter((session) => !session.archived), [inventory.sessions])
  const byId = useMemo(() => new Map(sessions.map((session) => [session.sessionId, session])), [sessions])
  const pending = useMemo<CrewPendingInput>(() => ({
    awaitingPermission: input.awaitingPermission,
    awaitingQuestion: input.awaitingQuestion,
    awaitingPrompt: new Set([...input.awaitingElicitation, ...input.awaitingDialog]),
    awaitingPlan: input.awaitingPlan,
  }), [input])
  const statusOf = (member: ActiveSessionInfo) => memberStatus(member, inventory.procBySession, pending)
  const canAnswer = (sessionId: string) => {
    const session = byId.get(sessionId)
    return permissionsOf(session?.access).canInteract
  }
  const queue = homeQueue(input, sessions, canAnswer)
  const nameOf = (sessionId: string) => crewSessionTitle(sessionId, byId, names)
  const projectLabel = (session: ActiveSessionInfo) => projectNames[session.dirName] ?? sessionGroupKey(session)
  const rows = homeSessionRows(sessions, statusOf)
  const searching = query.trim().length > 0
  const yours = searching
    ? searchHomeSessions(rows, query, (entry) => [
      nameOf(entry.session.sessionId),
      projectLabel(entry.session),
      entry.session.gitBranch,
      entry.session.cwd,
      entry.session.lastUserMessage,
      entry.session.firstUserMessage,
      entry.landed?.title,
      entry.landed && `#${entry.landed.number}`,
      ...entry.crew.map(({ member }) => nameOf(member.sessionId)),
    ])
    : homeSessions(rows)
  const recent = recentHomeProjects(rows, (session) => suggestedProject(session, projectNames))
  const open = (sessionId: string) => {
    const session = byId.get(sessionId)
    if (session) onOpenSession(session.dirName, session.fileName)
    else void revealSessionById(sessionId)
  }
  const running = inventory.processes.filter((process) => process.sessionId).length

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "/" && isShortcutTarget(event)) {
        event.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mx-auto flex w-full max-w-6xl shrink-0 flex-col gap-8 px-6 pt-16 lg:px-10">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h1 className="text-xl font-semibold tracking-tight">Mission Control</h1>
          {running > 0 && <p className="text-xs text-muted-foreground">{running} {running === 1 ? "agent" : "agents"} running on this machine</p>}
        </div>
        {start && <HomeComposer recent={recent} start={start} />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto lg:overflow-hidden">
        <div
          className={cn(
            "mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 pb-10 pt-10 lg:h-full lg:px-10",
            queue.length > 0 && "lg:grid lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]",
          )}
        >
          {queue.length > 0 ? (
            <NeedsYouQueue queue={queue} input={input} byId={byId} nameOf={nameOf} onOpen={open} canAnswer={canAnswer} />
          ) : (
            <p className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
              <span className="size-1.5 rounded-full bg-success/40" aria-hidden="true" />
              Nothing is waiting on you.
            </p>
          )}
          <YourSessions
            sessions={yours}
            total={rows.length}
            query={query}
            onQueryChange={setQuery}
            searchRef={searchRef}
            nameOf={nameOf}
            projectLabel={projectLabel}
            onOpen={open}
            onRename={rename}
            onBrowseProjects={onBrowseProjects}
          />
        </div>
      </div>
    </div>
  )
}

function SectionHeading({ title, count, children }: { title: string; count?: number; children?: React.ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <h2 className="text-sm font-medium">{title}</h2>
      {count !== undefined && <span className="text-xs tabular-nums text-muted-foreground">{count}</span>}
      <span className="flex-1" />
      {children}
    </div>
  )
}

/** "w3-rooftop · Wave 3 coordinator": a member is named with the crew it belongs to. */
function lineageLabel(session: ActiveSessionInfo | undefined, nameOf: (sessionId: string) => string | undefined): string | null {
  const crew = session?.crew
  if (!crew) return null
  return nameOf(crew.rootId) ?? crew.rootTitle ?? null
}

const KIND_LABEL: Record<HomeRequest["kind"], string> = {
  permission: "asked a permission",
  question: "asked a question",
  elicitation: "asked for input",
  dialog: "needs a choice",
  plan: "has a plan to review",
  deferred: "has a deferred permission",
}

function NeedsYouQueue({
  queue,
  input,
  byId,
  nameOf,
  onOpen,
  canAnswer,
}: {
  queue: HomeRequest[]
  input: ReturnType<typeof usePendingHumanInput>
  byId: ReadonlyMap<string, ActiveSessionInfo>
  nameOf: (sessionId: string) => string | undefined
  onOpen: (sessionId: string) => void
  canAnswer: (sessionId: string) => boolean
}) {
  const [index, setIndex] = useState(0)
  const answering = useRef(new Set<string>())
  const at = Math.min(index, queue.length - 1)
  const request = queue[at]!
  const session = byId.get(request.sessionId)
  const lineage = lineageLabel(session, nameOf)
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement
    if (target.closest("input,textarea,select,[contenteditable=true]") || event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key === "j" || event.key === "n" || event.key === "ArrowDown") { event.preventDefault(); setIndex(Math.min(queue.length - 1, at + 1)) }
    if (event.key === "k" || event.key === "ArrowUp") { event.preventDefault(); setIndex(Math.max(0, at - 1)) }
    if (event.key === "o") { event.preventDefault(); onOpen(request.sessionId) }
    if ((event.key === "Enter" || event.key === "d") && target === event.currentTarget && canAnswer(request.sessionId)) {
      if (request.kind !== "permission") return
      const decision = event.key === "d" || request.request.defaultToNo ? "deny" : "allow"
      const requestId = request.request.requestId
      if (request.request.availableDecisions && !request.request.availableDecisions.includes(decision)) return
      event.preventDefault()
      if (answering.current.has(requestId) || input.responding.has(requestId)) return
      answering.current.add(requestId)
      void input.respond(request.sessionId, requestId, decision).finally(() => answering.current.delete(requestId))
    }
  }

  return (
    <section aria-label="Needs you" tabIndex={0} onKeyDown={onKeyDown} className="min-w-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring lg:min-h-0 lg:overflow-y-auto">
      <SectionHeading title="Needs you" count={queue.length}>
        {queue.length > 1 && (
          <span className="flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
            {at + 1} of {queue.length}
            <Button variant="ghost" size="icon-xs" aria-label="Previous request" disabled={at === 0} onClick={() => setIndex(at - 1)}>
              <ChevronLeft data-icon="inline-start" />
            </Button>
            <Button variant="ghost" size="icon-xs" aria-label="Next request" disabled={at === queue.length - 1} onClick={() => setIndex(at + 1)}>
              <ChevronRight data-icon="inline-start" />
            </Button>
          </span>
        )}
      </SectionHeading>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 px-0.5 text-[13px]">
          <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-hidden="true" />
          <button type="button" onClick={() => onOpen(request.sessionId)} className="min-w-0 truncate rounded-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
            {nameOf(request.sessionId) ?? "A session"}
          </button>
          {lineage && <span className="min-w-0 truncate text-muted-foreground">· {lineage}</span>}
          <span className="ml-auto shrink-0 text-xs tabular-nums text-warning">
            waiting {formatRelativeTime(new Date(request.since).toISOString())}
          </span>
        </div>
        <p className="px-0.5 text-xs text-muted-foreground">{KIND_LABEL[request.kind]}</p>
        <HomeRequestPrompt key={homeRequestId(request)} request={request} input={input} canAnswer={canAnswer(request.sessionId)} onOpen={() => onOpen(request.sessionId)} />
      </div>
      {queue.length > 1 && (
        <ol className="mt-3 flex flex-col" aria-label="Also waiting">
          {queue.map((other, position) => position === at ? null : (
            <li key={homeRequestId(other)}>
              <button
                type="button"
                onClick={() => setIndex(position)}
                className="grid w-full grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg px-2 py-2 text-left text-[12.5px] outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="text-right text-[11px] tabular-nums text-muted-foreground/80">{position + 1}</span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">
                    {nameOf(other.sessionId) ?? "A session"}
                    {lineageLabel(byId.get(other.sessionId), nameOf) && (
                      <span className="font-normal text-muted-foreground"> · {lineageLabel(byId.get(other.sessionId), nameOf)}</span>
                    )}
                  </span>
                  <span className="truncate text-[11.5px] text-muted-foreground">{KIND_LABEL[other.kind]}</span>
                </span>
                <span className="text-[11px] tabular-nums text-warning">{formatRelativeTime(new Date(other.since).toISOString())}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
      <p className="mt-2 px-0.5 text-[11px] text-muted-foreground/80">J / K move · Enter answers · D denies · O opens</p>
    </section>
  )
}

/** The row's dot: attention if the session or anyone in its crew needs the user, live if any of them is working. */
function rowDot(entry: HomeSession): string | null {
  if (entry.state === "needs-you" || (entry.counts?.needsYou ?? 0) > 0) return STATUS_DOT.attention
  if (entry.state === "working" || (entry.counts?.working ?? 0) > 0) return STATUS_DOT.working
  return null
}

function YourSessions({
  sessions,
  total,
  query,
  onQueryChange,
  searchRef,
  nameOf,
  projectLabel,
  onOpen,
  onRename,
  onBrowseProjects,
}: {
  sessions: HomeSession[]
  total: number
  query: string
  onQueryChange: (query: string) => void
  searchRef: RefObject<HTMLInputElement | null>
  nameOf: (sessionId: string) => string | undefined
  projectLabel: (session: ActiveSessionInfo) => string
  onOpen: (sessionId: string) => void
  onRename: (sessionId: string, name: string) => void
  onBrowseProjects?: () => void
}) {
  const searching = query.trim().length > 0
  const clear = () => {
    onQueryChange("")
    searchRef.current?.focus()
  }
  return (
    <section aria-label="Your sessions" className="flex min-w-0 flex-col lg:min-h-0 lg:flex-1">
      <SectionHeading title="Your sessions" count={searching ? sessions.length : total}>
        <div className="relative w-full max-w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            ref={searchRef}
            type="search"
            aria-label="Search sessions"
            placeholder="Search sessions"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); clear(); searchRef.current?.blur() } }}
            className="h-7 pl-8 pr-7 text-xs [&::-webkit-search-cancel-button]:hidden"
          />
          {searching ? (
            <button type="button" aria-label="Clear search" onClick={clear} className="absolute right-1.5 top-1/2 flex size-4 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
              <X className="size-3" />
            </button>
          ) : (
            <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-mono text-[10px] text-muted-foreground/70" aria-hidden="true">/</kbd>
          )}
        </div>
        {onBrowseProjects && (
          <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={onBrowseProjects}>
            <FolderOpen data-icon="inline-start" />
            All projects
          </Button>
        )}
      </SectionHeading>
      {sessions.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyDescription>
              {searching ? `No session matches “${query.trim()}”.` : "Start a session and it shows up here, with every session it starts."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="flex flex-col lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
          {sessions.map((entry) => (
            <SessionRow key={entry.session.sessionId} entry={entry} nameOf={nameOf} projectLabel={projectLabel} onOpen={onOpen} onRename={onRename} />
          ))}
        </ul>
      )}
    </section>
  )
}

/** One session with its crew; the title can be edited in place, saved with Enter and dropped with Escape. */
function SessionRow({
  entry,
  nameOf,
  projectLabel,
  onOpen,
  onRename,
}: {
  entry: HomeSession
  nameOf: (sessionId: string) => string | undefined
  projectLabel: (session: ActiveSessionInfo) => string
  onOpen: (sessionId: string) => void
  onRename: (sessionId: string, name: string) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const { session } = entry
  const title = nameOf(session.sessionId) ?? "Untitled session"
  const ownTitle = sessionTitle(session)
  const dot = rowDot(entry)
  const commit = () => {
    if (draft === null) return
    const next = draft.trim()
    setDraft(null)
    if (next === title) return
    onRename(session.sessionId, next === ownTitle ? "" : next)
  }
  const details = (
    <>
      <span className="flex items-center gap-3 text-xs text-muted-foreground">
        {entry.counts ? (
          <>
            {entry.counts.working > 0 && <span><span className="font-medium text-foreground tabular-nums">{entry.counts.working}</span> working</span>}
            {entry.counts.needsYou > 0 && <span className="text-warning"><span className="font-medium tabular-nums">{entry.counts.needsYou}</span> need you</span>}
            <span><span className="font-medium text-foreground tabular-nums">{entry.counts.size}</span> in crew</span>
          </>
        ) : (
          session.isActive && <span>working</span>
        )}
      </span>
      <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        {entry.landed && (
          <Badge variant="outline" className="shrink-0">#{entry.landed.number}</Badge>
        )}
        <span className="truncate">
          {entry.landed ? `${entry.landed.title ?? "Pull request"} · ${nameOf(entry.landed.by.sessionId) ?? ""}` : session.lastUserMessage ?? ""}
        </span>
      </span>
      <span className="text-[11px] tabular-nums text-muted-foreground/80">
        {entry.counts ? `crew active ${formatRelativeTime(entry.activityAt)}` : formatRelativeTime(entry.activityAt)}
      </span>
    </>
  )
  const rowClass = "grid w-full grid-cols-1 items-center gap-x-4 gap-y-1 rounded-lg py-3 pl-3 pr-10 text-left xl:grid-cols-[minmax(0,1fr)_auto]"

  return (
    <li className="group/row relative border-t border-border/70 first:border-t-0">
      {draft === null ? (
        <button
          type="button"
          onClick={() => onOpen(session.sessionId)}
          className={cn(rowClass, "outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring")}
        >
          <span className="flex min-w-0 items-center gap-2.5">
            {dot && <span className={cn("size-1.5 shrink-0 rounded-full", dot)} aria-hidden="true" />}
            <span className="truncate text-[13.5px] font-medium">{title}</span>
            <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:inline">{projectLabel(session)}</span>
          </span>
          {details}
        </button>
      ) : (
        <div className={rowClass}>
          <span className="flex min-w-0 items-center gap-2.5">
            {dot && <span className={cn("size-1.5 shrink-0 rounded-full", dot)} aria-hidden="true" />}
            <Input
              autoFocus
              aria-label="Session name"
              value={draft}
              placeholder={ownTitle}
              onChange={(event) => setDraft(event.target.value)}
              onFocus={(event) => event.target.select()}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === "Enter") { event.preventDefault(); commit() }
                if (event.key === "Escape") { event.preventDefault(); setDraft(null) }
              }}
              className="h-7 max-w-md text-[13.5px] font-medium"
            />
            <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:inline">{projectLabel(session)}</span>
          </span>
          {details}
        </div>
      )}
      {entry.crew.length > 0 && <CrewStrip entry={entry} title={title} nameOf={nameOf} onOpen={onOpen} />}
      {draft === null && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Rename ${title}`}
          title="Rename"
          onClick={() => setDraft(title)}
          className="absolute right-2 top-2.5 text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
        >
          <Pencil data-icon="icon" />
        </Button>
      )}
    </li>
  )
}

/**
 * A session's crew under its row: the members working or waiting on the user
 * by name, and the whole crew, however large, one click away.
 */
function CrewStrip({
  entry,
  title,
  nameOf,
  onOpen,
}: {
  entry: HomeSession
  title: string
  nameOf: (sessionId: string) => string | undefined
  onOpen: (sessionId: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const live = entry.crew.filter(({ state }) => state !== "done")
  const named = live.slice(0, CREW_CHIPS)
  const viaOf = (member: ActiveSessionInfo) => {
    const parentId = member.crew?.parentId
    return parentId && parentId !== entry.session.sessionId ? nameOf(parentId) : undefined
  }
  return (
    <div className="-mt-1.5 flex flex-col gap-1.5 px-3 pb-3">
      <div role="group" aria-label={`${title} crew`} className="flex min-w-0 flex-wrap items-center gap-1.5">
        {!expanded && named.map(({ member, state }) => (
          <button
            key={member.sessionId}
            type="button"
            aria-label={`Open ${nameOf(member.sessionId) ?? "crew member"}`}
            onClick={() => onOpen(member.sessionId)}
            className="flex max-w-56 items-center gap-1.5 rounded-md border border-border/70 px-2 py-0.5 text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className={cn("size-1.5 shrink-0 rounded-full", MEMBER_DOT[state])} aria-hidden="true" />
            <span className="truncate">{nameOf(member.sessionId) ?? "Crew member"}</span>
          </button>
        ))}
        {!expanded && live.length > named.length && (
          <span className="text-xs tabular-nums text-muted-foreground">+{live.length - named.length} more</span>
        )}
        <Button
          variant="ghost"
          size="xs"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="text-muted-foreground"
        >
          <ChevronDown data-icon="inline-start" className={cn("transition-transform", expanded && "rotate-180")} />
          {expanded ? "Hide crew" : `Show crew (${entry.crew.length})`}
        </Button>
      </div>
      {expanded && (
        <ul aria-label={`${title} crew members`} className="flex max-h-72 flex-col overflow-y-auto rounded-md border border-border/70">
          {entry.crew.map(({ member, state }) => (
            <li key={member.sessionId}>
              <button
                type="button"
                aria-label={`Open ${nameOf(member.sessionId) ?? "crew member"}`}
                onClick={() => onOpen(member.sessionId)}
                className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 px-2.5 py-1.5 text-left text-xs outline-none hover:bg-accent focus-visible:bg-accent"
              >
                <span className={cn("size-1.5 rounded-full", MEMBER_DOT[state])} aria-hidden="true" />
                <span className="truncate">
                  {nameOf(member.sessionId) ?? "Crew member"}
                  {viaOf(member) && <span className="text-muted-foreground"> · via {viaOf(member)}</span>}
                </span>
                <span className={cn("tabular-nums text-muted-foreground", state === "needs-you" && "text-warning")}>
                  {state === "done" ? formatRelativeTime(member.lastActivityAt || member.lastModified) : MEMBER_STATE[state]}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
