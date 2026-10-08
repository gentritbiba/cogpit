import { useMemo, useState } from "react"
import { ChevronLeft, ChevronRight, MailCheck, Network, Square, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { PendingInputPrompt } from "@/components/PendingInputPrompt"
import { useSessionNames } from "@/hooks/useSessionNames"
import { useSessionCrew } from "@/hooks/useSessionCrew"
import { formatRelativeTime } from "@/lib/format"
import { revealSessionById, revealSessionPath, sessionPath } from "@/lib/revealSession"
import { cn } from "@/lib/utils"
import type { WorkspacePanelProps } from "@/plugin-api"
import type { CrewMember, SessionCrew } from "../../../shared/contracts/crew"
import { shortenModel } from "../../../shared/session/model-names"
import {
  crewMemberName,
  crewRequests,
  crewTally,
  crewTree,
  hasUnreadResult,
  memberActivity,
  memberCellState,
  type CrewCellState,
  type CrewTreeRow,
} from "./crewView"

type Filter = "all" | "working" | "needs-you" | "done"

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "working", label: "Working" },
  { id: "needs-you", label: "Need you" },
  { id: "done", label: "Done" },
]

const CELL: Record<CrewCellState, string> = {
  working: "bg-success shadow-[0_0_0_2px_color-mix(in_oklch,var(--success)_25%,transparent)]",
  "needs-you": "bg-warning",
  done: "bg-muted-foreground/40",
  failed: "bg-destructive",
  unreachable: "border border-muted-foreground/50",
}

const DOT: Record<CrewCellState, string> = {
  working: "bg-success ring-2 ring-success/30",
  "needs-you": "bg-warning",
  done: "bg-muted-foreground/50",
  failed: "bg-destructive",
  unreachable: "border border-muted-foreground/60",
}

/**
 * The crew of the open session, pinned to its root wherever in the crew the
 * user is: a strip with one cell per member, the requests it is blocked on
 * one at a time, and every member in the order it was started.
 */
export function CrewPanel({ context, closePanel }: WorkspacePanelProps) {
  const sessionId = context.session?.sessionId ?? null
  const { crew, error, busy, respond, markRead, stop } = useSessionCrew(sessionId)
  const { names } = useSessionNames()
  const byId = useMemo(() => new Map((crew?.members ?? []).map((member) => [member.sessionId, member])), [crew])
  const nameOf = (member: CrewMember) => crewMemberName(member, byId, names)
  const open = (member: CrewMember) => {
    if (member.address && member.device) revealSessionPath(sessionPath(member.address.dirName, member.address.fileName, member.device.id))
    else if (member.address && context.openSession) context.openSession(member.address.dirName, member.address.fileName)
    else void revealSessionById(member.sessionId)
  }

  return (
    <aside aria-label="Crew" className="flex size-full min-h-0 flex-col bg-canvas">
      <div className="flex h-10 shrink-0 items-center gap-2 px-3">
        <Network aria-hidden="true" className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Crew</h2>
        <div className="flex-1" />
        <Button variant="ghost" size="icon-sm" onClick={closePanel} aria-label="Close crew">
          <X data-icon="inline-start" />
        </Button>
      </div>
      {error && <p role="alert" className="px-3 pb-2 text-xs text-destructive">{error}</p>}
      {!crew ? (
        !error && <p className="px-3 py-6 text-center text-sm text-muted-foreground">Loading the crew…</p>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <CrewRoll crew={crew} hereId={sessionId} nameOf={nameOf} onOpen={open} />
          <NeedsYou crew={crew} busy={busy} nameOf={nameOf} onOpen={open} onRespond={respond} />
          <CrewSessions
            crew={crew}
            hereId={sessionId}
            busy={busy}
            nameOf={nameOf}
            onOpen={open}
            onMarkRead={markRead}
            onStop={stop}
          />
        </ScrollArea>
      )}
    </aside>
  )
}

interface CrewSectionProps {
  crew: SessionCrew
  nameOf: (member: CrewMember) => string
  onOpen: (member: CrewMember) => void
}

function CrewRoll({ crew, hereId, nameOf, onOpen }: CrewSectionProps & { hereId: string | null }) {
  const root = crew.members.find((member) => member.sessionId === crew.rootId)
  const members = crew.members.filter((member) => member.parentId !== null)
  const tally = crewTally(crew)
  const since = members[0]?.startedAt
  return (
    <section aria-label="Crew summary" className="border-b px-3 pb-3 pt-1">
      <div className="flex items-baseline gap-2">
        {root && (
          <button
            type="button"
            onClick={() => onOpen(root)}
            aria-current={root.sessionId === hereId ? "true" : undefined}
            className="min-w-0 flex-1 truncate rounded-sm text-left text-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {nameOf(root)}
          </button>
        )}
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {tally.size} {tally.size === 1 ? "session" : "sessions"}
          {since ? ` · since ${startedLabel(since)}` : ""}
        </span>
      </div>
      {members.length > 0 && (
        <div data-crew-strip className="mt-2.5 flex gap-[3px]" role="list" aria-label="One cell per session, in the order they were started">
          {members.map((member) => {
            const state = memberCellState(member)
            return (
              <button
                key={member.sessionId}
                type="button"
                role="listitem"
                data-crew-cell={state}
                title={`${nameOf(member)}: ${memberActivity(member)}`}
                aria-label={`${nameOf(member)}: ${memberActivity(member)}`}
                onClick={() => document.querySelector(`[data-crew-row="${member.sessionId}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" })}
                className={cn(
                  "h-2.5 min-w-[3px] flex-1 rounded-[2px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  CELL[state],
                  member.sessionId === hereId && "outline outline-[1.5px] outline-offset-2 outline-foreground",
                )}
              />
            )
          })}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs text-muted-foreground">
        {tally.working > 0 && <Count dot={DOT.working} value={tally.working} label="working" />}
        {tally.needsYou > 0 && <Count dot={DOT["needs-you"]} value={tally.needsYou} label={tally.needsYou === 1 ? "needs you" : "need you"} />}
        {tally.done > 0 && <Count dot={DOT.done} value={tally.done} label="done" />}
        {tally.failed > 0 && <Count dot={DOT.failed} value={tally.failed} label="failed" />}
        {tally.unreachable > 0 && <Count dot={DOT.unreachable} value={tally.unreachable} label="away" />}
        {tally.unreadResults > 0 && (
          <span className="ml-auto text-warning">
            <span className="font-medium tabular-nums">{tally.unreadResults}</span> {tally.unreadResults === 1 ? "result" : "results"} unread
          </span>
        )}
      </div>
    </section>
  )
}

/** "14:05" today, "Oct 6, 22:43" on an earlier day. */
function startedLabel(at: number): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  if (date.toDateString() === new Date().toDateString()) return time
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`
}

function Count({ dot, value, label }: { dot: string; value: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("size-1.5 rounded-full", dot)} aria-hidden="true" />
      <span className="font-medium tabular-nums text-foreground">{value}</span> {label}
    </span>
  )
}

function NeedsYou({
  crew,
  busy,
  nameOf,
  onOpen,
  onRespond,
}: CrewSectionProps & {
  busy: ReadonlySet<string>
  onRespond: ReturnType<typeof useSessionCrew>["respond"]
}) {
  const requests = crewRequests(crew)
  const [index, setIndex] = useState(0)
  if (requests.length === 0) return null
  const at = Math.min(index, requests.length - 1)
  const { member, pending } = requests[at]!
  const next = requests[at + 1]
  return (
    <section aria-label="Needs you" className="border-b px-3 py-2.5">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <h3 className="text-sm font-medium text-foreground">Needs you</h3>
        <span className="tabular-nums">{requests.length}</span>
        <span className="flex-1" />
        {requests.length > 1 && (
          <>
            <span className="tabular-nums">{at + 1} of {requests.length}</span>
            <Button variant="ghost" size="icon-xs" aria-label="Previous request" disabled={at === 0} onClick={() => setIndex(at - 1)}>
              <ChevronLeft data-icon="inline-start" />
            </Button>
            <Button variant="ghost" size="icon-xs" aria-label="Next request" disabled={at === requests.length - 1} onClick={() => setIndex(at + 1)}>
              <ChevronRight data-icon="inline-start" />
            </Button>
          </>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2 px-0.5 text-xs">
          <span className={cn("size-1.5 shrink-0 rounded-full", DOT["needs-you"])} aria-hidden="true" />
          <span className="min-w-0 truncate font-medium text-foreground">{nameOf(member)}</span>
          {member.device && <Badge variant="outline">{member.device.name}</Badge>}
          <span className="ml-auto shrink-0 tabular-nums text-warning">
            {pending.askedAt ? `waiting ${formatRelativeTime(new Date(pending.askedAt).toISOString())}` : "waiting"}
          </span>
        </div>
        <PendingInputPrompt
          key={pending.requestId}
          sessionId={member.sessionId}
          pending={pending}
          queued={0}
          responding={busy.has(pending.requestId)}
          onRespond={(requestId, response) => void onRespond(member.sessionId, requestId, response)}
          onOpen={() => onOpen(member)}
        />
        <Button variant="ghost" size="xs" className="self-end text-muted-foreground" onClick={() => onOpen(member)}>
          Open session
          <ChevronRight data-icon="inline-end" />
        </Button>
      </div>
      {next && (
        <p className="mt-2 truncate text-xs text-muted-foreground">
          Next: <span className="font-medium text-foreground">{nameOf(next.member)}</span> {memberActivity(next.member).toLowerCase()}
        </p>
      )}
    </section>
  )
}

function CrewSessions({
  crew,
  hereId,
  busy,
  nameOf,
  onOpen,
  onMarkRead,
  onStop,
}: CrewSectionProps & {
  hereId: string | null
  busy: ReadonlySet<string>
  onMarkRead: (parentId: string, taskId: string) => Promise<void>
  onStop: (member: CrewMember) => Promise<void>
}) {
  const [filter, setFilter] = useState<Filter>("all")
  const rows = crewTree(crew).filter(({ member }) => {
    if (filter === "all") return true
    const state = memberCellState(member)
    return filter === "done" ? state !== "working" && state !== "needs-you" : state === filter
  })
  return (
    <section aria-label="Sessions" className="px-1.5 py-2.5">
      <div className="mb-1.5 flex items-center gap-2 px-1.5">
        <h3 className="text-sm font-medium">Sessions</h3>
        <span className="flex-1" />
        <div role="radiogroup" aria-label="Show sessions" className="flex gap-0.5">
          {FILTERS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={filter === id}
              onClick={() => setFilter(id)}
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                filter === id && "bg-accent text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="px-1.5 py-4 text-center text-xs text-muted-foreground">No sessions here.</p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((row) => (
            <CrewRow
              key={row.member.sessionId}
              row={row}
              here={row.member.sessionId === hereId}
              busy={busy}
              name={nameOf(row.member)}
              onOpen={onOpen}
              onMarkRead={onMarkRead}
              onStop={onStop}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

function CrewRow({
  row: { member, depth, children },
  here,
  busy,
  name,
  onOpen,
  onMarkRead,
  onStop,
}: {
  row: CrewTreeRow
  here: boolean
  busy: ReadonlySet<string>
  name: string
  onOpen: (member: CrewMember) => void
  onMarkRead: (parentId: string, taskId: string) => Promise<void>
  onStop: (member: CrewMember) => Promise<void>
}) {
  const state = memberCellState(member)
  const activity = memberActivity(member)
  const pullRequest = member.pullRequests?.at(-1)
  const unread = hasUnreadResult(member) && member.result && member.parentId
  const canStop = (state === "working" || state === "needs-you")
    && (!member.device || (member.result?.state === "running" && member.parentId !== null))
  return (
    <li
      data-crew-row={member.sessionId}
      className={cn("group/crew relative rounded-md", here ? "bg-accent" : "hover:bg-accent/60", depth > 0 && "border-l border-border/70")}
      style={{ marginLeft: depth > 0 ? 6 + (depth - 1) * 14 : 0 }}
    >
      <button
        type="button"
        onClick={() => onOpen(member)}
        aria-current={here ? "true" : undefined}
        aria-label={`${name}, ${activity}`}
        className="grid w-full grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className={cn("size-1.5 justify-self-center rounded-full", DOT[state])} aria-hidden="true" />
        <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] font-medium">
          <span className="truncate">{name}</span>
          {here && <span className="shrink-0 rounded-full border px-1.5 text-[10.5px] font-normal text-muted-foreground">you are here</span>}
        </span>
        <span className="text-[11px] tabular-nums text-muted-foreground/80">
          {member.lastActivityAt ? formatRelativeTime(member.lastActivityAt) : ""}
        </span>
        <span className="col-start-2 col-end-4 flex min-w-0 items-center gap-2 text-[11.5px] text-muted-foreground">
          <span className={cn(
            "min-w-0 flex-1 truncate",
            (state === "needs-you" || unread) && "text-warning",
            state === "failed" && "text-destructive",
          )}
          >
            {activity}
          </span>
          {pullRequest && <span className="shrink-0 rounded-full border px-1.5 text-[11px]">#{pullRequest.number}</span>}
          {member.device && <span className="shrink-0">{member.device.name}</span>}
          {children > 0 && <span className="shrink-0">{children} {children === 1 ? "session" : "sessions"}</span>}
          {member.model && <span className="shrink-0 text-muted-foreground/70">{shortenModel(member.model)}</span>}
        </span>
      </button>
      {(unread || canStop) && (
        <div className="absolute right-1.5 top-1 hidden gap-1 group-focus-within/crew:flex group-hover/crew:flex">
          {unread && member.result && member.parentId && (
            <Button
              variant="outline"
              size="icon-xs"
              className="bg-popover"
              aria-label={`Mark ${name}'s result read`}
              title="Mark the result read"
              disabled={busy.has(member.result.taskId)}
              onClick={() => void onMarkRead(member.parentId!, member.result!.taskId)}
            >
              <MailCheck data-icon="inline-start" />
            </Button>
          )}
          {canStop && (
            <Button
              variant="outline"
              size="icon-xs"
              className="bg-popover text-destructive"
              aria-label={`Stop ${name}`}
              title="Stop this session"
              disabled={busy.has(member.sessionId)}
              onClick={() => void onStop(member)}
            >
              <Square data-icon="inline-start" />
            </Button>
          )}
        </div>
      )}
    </li>
  )
}
