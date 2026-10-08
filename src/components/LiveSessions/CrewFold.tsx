import { useState } from "react"
import { ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatRelativeTime } from "@/lib/format"
import { getSessionRecencyMs } from "../../../shared/session-ordering"
import { workingChip } from "./attentionGroups"
import { directReports, memberName, type CrewCounts, type MemberNeed, type MemberStatus } from "./crew"
import { STATUS_DOT } from "./statusDot"
import type { ActiveSessionInfo } from "./types"

/** Done members shown before the rest fold into a link. */
const DONE_VISIBLE = 6

const NEED_LABEL: Record<MemberNeed, string> = {
  permission: "permission",
  question: "question",
  input: "input",
  plan: "plan",
  deferred: "deferred",
}

const STATE_ORDER: Record<MemberStatus["state"], number> = { "needs-you": 0, working: 1, done: 2 }

export interface CrewFoldProps {
  host: ActiveSessionInfo
  members: ActiveSessionInfo[]
  counts: CrewCounts
  statusOf: (member: ActiveSessionInfo) => MemberStatus
  open: boolean
  onToggle: () => void
  sessionNames: Record<string, string>
  activeSessionKey: string | null
  onSelectSession: (dirName: string, fileName: string) => void
}

/**
 * The line that closes a crew's root card: how many sessions it started and
 * which of them need someone or are working. Open, it lists them by what they
 * are doing, the finished ones folded after the first few.
 */
export function CrewFold({
  host,
  members,
  counts,
  statusOf,
  open,
  onToggle,
  sessionNames,
  activeSessionKey,
  onSelectSession,
}: CrewFoldProps) {
  const [showAllDone, setShowAllDone] = useState(false)
  const byId = new Map([host, ...members].map((value) => [value.sessionId, value]))
  // Two levels: the sessions this one started, and any deeper one waiting on
  // someone so it never hides behind the session that started it.
  const isDirect = (value: ActiveSessionInfo) => !value.crew || value.crew.parentId === host.sessionId || !byId.has(value.crew.parentId)
  const listed = members.filter((value) => isDirect(value) || statusOf(value).state === "needs-you")
  const ordered = [...listed].sort((a, b) => (
    STATE_ORDER[statusOf(a).state] - STATE_ORDER[statusOf(b).state]
    || (statusOf(a).state === "done" ? getSessionRecencyMs(b) - getSessionRecencyMs(a) : 0)
  ))
  const done = ordered.filter((value) => statusOf(value).state === "done")
  const hiddenDone = showAllDone ? [] : done.slice(DONE_VISIBLE)
  const shown = ordered.filter((value) => !hiddenDone.includes(value))
  const summary = `Crew of ${counts.size}${counts.needsYou ? `, ${counts.needsYou} need you` : ""}${counts.working ? `, ${counts.working} working` : ""}`

  return (
    <div data-crew-fold className="mx-3 mb-2 ml-[26px] border-t border-border/60 pt-1.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={open ? `Hide crew: ${summary}` : `Show crew: ${summary}`}
        className="flex w-full items-center gap-1.5 rounded-sm py-0.5 text-left text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight className={cn("size-3 shrink-0 transition-transform duration-150", open && "rotate-90")} aria-hidden="true" />
        <span className="font-medium text-foreground">Crew</span>
        <span className="tabular-nums">· {counts.size}</span>
        {counts.needsYou > 0 && <span className="tabular-nums text-warning">· {counts.needsYou} need you</span>}
        {counts.working > 0 && <span className="tabular-nums">· {counts.working} working</span>}
      </button>
      {open && (
        <ul className="mt-1 ml-1.5 flex flex-col gap-px border-l border-border/70 pl-1.5">
          {shown.map((value) => {
            const status = statusOf(value)
            const reports = directReports(value.sessionId, members)
            const parent = value.crew ? byId.get(value.crew.parentId) : undefined
            const isActive = activeSessionKey === `${value.dirName}/${value.fileName}`
            const name = memberName(value, { customName: sessionNames[value.sessionId], parent: parent ?? host })
            const activity = memberActivity(value, status)
            const via = !isDirect(value) && parent
              ? ` · via ${memberName(parent, { customName: sessionNames[parent.sessionId], parent: byId.get(parent.crew?.parentId ?? "") ?? host })}`
              : ""
            const reportsLabel = via || (reports > 0 ? ` · ${reports} ${reports === 1 ? "session" : "sessions"}` : "")
            return (
              <li key={value.sessionId}>
                <button
                  type="button"
                  data-crew-member={value.sessionId}
                  aria-current={isActive ? "true" : undefined}
                  aria-label={`${name}${reportsLabel}, ${activity}`}
                  onClick={() => onSelectSession(value.dirName, value.fileName)}
                  className={cn(
                    "flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                    isActive && "bg-accent",
                  )}
                >
                  <span className={cn("size-1.5 shrink-0 rounded-full", memberDot(status))} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">
                    {name}
                    {reportsLabel && <span className="text-muted-foreground/70">{reportsLabel}</span>}
                  </span>
                  <span className={cn("shrink-0 text-[11px] tabular-nums", status.state === "needs-you" ? "text-warning" : "text-muted-foreground/80")}>
                    {activity}
                  </span>
                </button>
              </li>
            )
          })}
          {hiddenDone.length > 0 && (
            <li>
              <button
                type="button"
                onClick={() => setShowAllDone(true)}
                className="rounded-sm px-1.5 py-1 text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                Show {hiddenDone.length} more done
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

function memberDot({ state }: MemberStatus): string {
  if (state === "needs-you") return STATUS_DOT.attention
  if (state === "working") return STATUS_DOT.working
  return "bg-muted-foreground/50"
}

/** What a member's row says it is doing, with how long ago where that matters. */
function memberActivity(value: ActiveSessionInfo, { state, need }: MemberStatus): string {
  const since = formatRelativeTime(value.lastActivityAt || value.lastModified)
  if (state === "needs-you") return `${NEED_LABEL[need ?? "input"]} · ${since}`
  if (state === "working") return workingChip(value)
  const pullRequest = value.pullRequests?.at(-1)
  return pullRequest ? `#${pullRequest.number} · ${since}` : since
}
