import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { ChevronLeft, ChevronRight, FolderOpen, Plus } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Empty, EmptyHeader, EmptyDescription } from "@/components/ui/empty"
import { memberStatus, type CrewPendingInput } from "@/components/LiveSessions/crew"
import { crewSessionTitle } from "@/components/LiveSessions/crew"
import { sessionGroupKey } from "@/components/LiveSessions/sessionListView"
import type { ActiveSessionInfo } from "@/components/LiveSessions/types"
import { usePendingHumanInput } from "@/contexts/PendingHumanInputContext"
import { useSessionInventory } from "@/contexts/SessionInventoryContext"
import { useListedPermissions } from "@/hooks/useListedPermissions"
import { useProjectNames } from "@/hooks/useProjectNames"
import { useSessionNames } from "@/hooks/useSessionNames"
import { formatRelativeTime } from "@/lib/format"
import { revealSessionById } from "@/lib/revealSession"
import { cn } from "@/lib/utils"
import { HomeRequestPrompt } from "./HomeRequestPrompt"
import { homeQueue, homeRequestId, homeSessions, landedToday, type HomeRequest, type HomeSession, type LandedEvent } from "./homeView"

const CELL: Record<string, string> = {
  working: "bg-success shadow-[0_0_0_1.5px_color-mix(in_oklch,var(--success)_25%,transparent)]",
  "needs-you": "bg-warning",
  done: "bg-muted-foreground/40",
}

export interface MissionHomeProps {
  onOpenSession: (dirName: string, fileName: string) => void
  /** Start a session; the composer the app shows for a new session takes it from there. */
  onNewSession?: () => void
  /** The full list of projects and their history. */
  onBrowseProjects?: () => void
  newSessionControl?: ReactNode
}

/**
 * The first screen: what is blocked on the user, across every session and
 * crew, answerable one request at a time; the sessions the user started, each
 * with its crew; and what landed today.
 */
export function MissionHome({ onOpenSession, onNewSession, onBrowseProjects, newSessionControl }: MissionHomeProps) {
  const inventory = useSessionInventory()
  const input = usePendingHumanInput()
  const { names } = useSessionNames()
  const { names: projectNames } = useProjectNames()
  const permissionsOf = useListedPermissions()
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
  const yours = homeSessions(sessions, statusOf)
  const landed = landedToday(sessions, statusOf)
  const nameOf = (sessionId: string) => crewSessionTitle(sessionId, byId, names)
  const open = (sessionId: string) => {
    const session = byId.get(sessionId)
    if (session) onOpenSession(session.dirName, session.fileName)
    else void revealSessionById(sessionId)
  }
  const running = inventory.processes.filter((process) => process.sessionId).length

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 pb-10 pt-16 lg:px-10">
        <h1 className="text-xl font-semibold tracking-tight">Mission Control</h1>
        <div className="grid gap-8 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
          <NeedsYouQueue queue={queue} input={input} byId={byId} nameOf={nameOf} onOpen={open} canAnswer={canAnswer} />
          <div className="flex min-w-0 flex-col gap-8">
            <YourSessions
              sessions={yours}
              nameOf={nameOf}
              projectLabel={(session) => projectNames[session.dirName] ?? sessionGroupKey(session)}
              onOpen={open}
              onNewSession={onNewSession}
              onBrowseProjects={onBrowseProjects}
            />
            <LandedToday events={landed} nameOf={nameOf} onOpen={open} />
          </div>
        </div>
        {running > 0 && <p className="text-xs text-muted-foreground">{running} {running === 1 ? "agent" : "agents"} running on this machine.</p>}
        {newSessionControl}
      </div>
    </ScrollArea>
  )
}

function SectionHeading({ title, count, children }: { title: string; count?: number; children?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-baseline gap-2">
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
  if (queue.length === 0) {
    return (
      <section aria-label="Needs you" className="min-w-0">
        <SectionHeading title="Needs you" count={0} />
        <Empty><EmptyHeader><EmptyDescription>Nothing is waiting on you.</EmptyDescription></EmptyHeader></Empty>
      </section>
    )
  }
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
    <section aria-label="Needs you" tabIndex={0} onKeyDown={onKeyDown} className="min-w-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring">
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

function YourSessions({
  sessions,
  nameOf,
  projectLabel,
  onOpen,
  onNewSession,
  onBrowseProjects,
}: {
  sessions: HomeSession[]
  nameOf: (sessionId: string) => string | undefined
  projectLabel: (session: ActiveSessionInfo) => string
  onOpen: (sessionId: string) => void
  onNewSession?: () => void
  onBrowseProjects?: () => void
}) {
  return (
    <section aria-label="Your sessions" className="min-w-0">
      <SectionHeading title="Your sessions" count={sessions.length}>
        {onBrowseProjects && (
          <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={onBrowseProjects}>
            <FolderOpen data-icon="inline-start" />
            All projects
          </Button>
        )}
        {onNewSession && (
          <Button variant="outline" size="xs" onClick={onNewSession}>
            <Plus data-icon="inline-start" />
            New session
          </Button>
        )}
      </SectionHeading>
      {sessions.length === 0 ? (
        <Empty><EmptyHeader><EmptyDescription>Start a session and it shows up here, with every session it starts.</EmptyDescription></EmptyHeader></Empty>
      ) : (
        <ul className="flex flex-col">
          {sessions.map((entry) => (
            <li key={entry.session.sessionId} className="border-t border-border/70 first:border-t-0">
              {entry.members.length > 0 && (
                <div role="group" aria-label={`${nameOf(entry.session.sessionId)} crew`} className="flex flex-wrap gap-1 px-3 pt-3">
                  {entry.members.map((member, cellIndex) => (
                    <button
                      key={member.sessionId}
                      type="button"
                      aria-label={`Open ${nameOf(member.sessionId) ?? "crew member"}`}
                      title={`${nameOf(member.sessionId)}: ${entry.cells[cellIndex]}`}
                      onClick={() => onOpen(member.sessionId)}
                      className="flex size-5 items-center justify-center rounded-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className={cn("size-2 rounded-[2px]", CELL[entry.cells[cellIndex]!])} />
                    </button>
                  ))}
                </div>
              )}
              <button
                type="button"
                onClick={() => onOpen(entry.session.sessionId)}
                className="grid w-full grid-cols-1 items-center gap-x-4 gap-y-1 rounded-lg px-3 py-3 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring xl:grid-cols-[minmax(0,1fr)_auto]"
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className="truncate text-[13.5px] font-medium">{nameOf(entry.session.sessionId) ?? "Untitled session"}</span>
                  <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:inline">{projectLabel(entry.session)}</span>
                </span>
                <span className="flex items-center gap-3 text-xs text-muted-foreground">
                  {entry.counts ? (
                    <>
                      {entry.counts.working > 0 && <span><span className="font-medium text-foreground tabular-nums">{entry.counts.working}</span> working</span>}
                      {entry.counts.needsYou > 0 && <span className="text-warning"><span className="font-medium tabular-nums">{entry.counts.needsYou}</span> need you</span>}
                      <span><span className="font-medium text-foreground tabular-nums">{entry.counts.size}</span> in crew</span>
                    </>
                  ) : (
                    entry.session.isActive && <span>working</span>
                  )}
                </span>
                <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                  {entry.landed && (
                    <Badge variant="outline" className="shrink-0">#{entry.landed.number}</Badge>
                  )}
                  <span className="truncate">
                    {entry.landed ? `${entry.landed.title ?? "Pull request"} · ${nameOf(entry.landed.by.sessionId) ?? ""}` : entry.session.lastUserMessage ?? ""}
                  </span>
                </span>
                <span className="text-[11px] tabular-nums text-muted-foreground/80">
                  {entry.counts ? `crew active ${formatRelativeTime(entry.activityAt)}` : formatRelativeTime(entry.activityAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function LandedToday({
  events,
  nameOf,
  onOpen,
}: {
  events: LandedEvent[]
  nameOf: (sessionId: string) => string | undefined
  onOpen: (sessionId: string) => void
}) {
  if (events.length === 0) return null
  return (
    <section aria-label="Landed today" className="min-w-0">
      <SectionHeading title="Landed today" />
      <ol className="flex flex-col">
        {events.map((event) => {
          const sessionId = event.kind === "started" ? event.parentId : event.session.sessionId
          const time = new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          return (
            <li key={`${event.kind}:${sessionId}:${event.at}`}>
              <button
                type="button"
                onClick={() => onOpen(sessionId)}
                className="grid w-full grid-cols-[48px_minmax(0,1fr)] items-baseline gap-2.5 rounded-md px-3 py-1.5 text-left text-[12.5px] outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="text-[11px] tabular-nums text-muted-foreground/80">{time}</span>
                <span className="min-w-0 truncate">{landedLine(event, nameOf)}</span>
              </button>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function landedLine(event: LandedEvent, nameOf: (sessionId: string) => string | undefined) {
  switch (event.kind) {
    case "pr":
      return (
        <>
          <Badge variant="outline" className="mr-2 text-success">#{event.number}</Badge>
          <span className="font-medium">{nameOf(event.session.sessionId) ?? "A session"}</span>
          <span className="text-muted-foreground"> · {event.title ?? "opened a pull request"}</span>
        </>
      )
    case "finished":
      return (
        <>
          <span className="font-medium">{nameOf(event.session.sessionId) ?? "A session"}</span>
          <span className="text-muted-foreground"> finished</span>
        </>
      )
    case "started":
      return (
        <>
          <span className="font-medium">
            {event.sessions.length === 1 ? nameOf(event.sessions[0]!.sessionId) ?? "A session" : `${event.sessions.length} sessions`}
          </span>
          <span className="text-muted-foreground"> started · {nameOf(event.parentId) ?? "by another session"}</span>
        </>
      )
  }
}
