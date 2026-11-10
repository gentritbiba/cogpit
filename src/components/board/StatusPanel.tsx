import { useEffect, useState } from "react"
import { ArrowUpRight, ChevronRight, ListChecks, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { FilterChip, FilterChipCount } from "@/components/ui/filter-chip"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useSessionBoards } from "@/hooks/useSessionBoards"
import { useSessionNamer } from "@/hooks/useSessionNamer"
import { formatRelativeTime } from "@/lib/format"
import { revealSessionById } from "@/lib/revealSession"
import { cn } from "@/lib/utils"
import type { WorkspacePanelProps } from "@/plugin-api"
import type { ListedBoard } from "../../../shared/contracts/board"
import { BoardItemText } from "./BoardItemText"
import { filledSections, needsYouCount, needsYouLabel, TONE_DOT, TONE_TEXT } from "./boardView"
import { useStatusPanel } from "./StatusPanelContext"

type Scope = "crew" | "all"

const CLOCK_TICK_MS = 30_000

/**
 * What each agent says about its own work, read without opening its
 * conversation: the session the panel leads with, open, and every other
 * board in its crew or on this machine, newest first.
 */
export function StatusPanel({ context, closePanel }: WorkspacePanelProps) {
  const boards = useSessionBoards()
  const statusPanel = useStatusPanel()
  const nameOf = useSessionNamer()
  const [scope, setScope] = useState<Scope>("crew")
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  useClockTick()

  const focusId = statusPanel?.target ?? context.sessionId ?? null
  const focus = focusId ? boards.get(focusId) ?? null : null
  const crewRoot = focus?.rootId ?? context.crew?.rootId ?? focusId
  const all = [...boards.values()]
  const crew = all.filter((board) => board.rootId === crewRoot)
  const shownScope: Scope = crew.length > 0 ? scope : "all"
  const listed = shownScope === "crew" ? crew : all
  const ordered = focus && listed.includes(focus) ? [focus, ...listed.filter((board) => board !== focus)] : listed
  const label = (board: ListedBoard) => nameOf(board.sessionId) ?? board.name ?? `Session ${board.sessionId.slice(0, 8)}`

  const toggle = (sessionId: string) => setExpanded((previous) => {
    const next = new Set(previous)
    if (!next.delete(sessionId)) next.add(sessionId)
    return next
  })

  return (
    <aside aria-label="Status" className="flex size-full min-h-0 flex-col bg-canvas">
      <div className="flex h-10 shrink-0 items-center gap-1.5 px-3">
        <ListChecks aria-hidden="true" className="size-4 text-muted-foreground" />
        <h2 className="mr-1 text-sm font-medium">Status</h2>
        {all.length > 0 && (
          <div role="group" aria-label="Which statuses" className="flex min-w-0 items-center gap-0.5">
            <FilterChip pressed={shownScope === "crew"} disabled={crew.length === 0} onClick={() => setScope("crew")}>
              Crew <FilterChipCount>{crew.length}</FilterChipCount>
            </FilterChip>
            <FilterChip pressed={shownScope === "all"} onClick={() => setScope("all")}>
              All <FilterChipCount>{all.length}</FilterChipCount>
            </FilterChip>
          </div>
        )}
        <div className="flex-1" />
        <Button variant="ghost" size="icon-sm" onClick={closePanel} aria-label="Close status">
          <X data-icon="inline-start" />
        </Button>
      </div>
      {ordered.length === 0 ? (
        <Empty className="min-h-48 rounded-none p-4">
          <EmptyHeader>
            <EmptyMedia variant="icon"><ListChecks /></EmptyMedia>
            <EmptyTitle>No status yet</EmptyTitle>
            <EmptyDescription>
              Agents publish what they are doing with <code className="font-mono text-[11px]">cogpit-session board set</code>,
              and it shows here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <ol className="flex flex-col gap-1 px-2 pb-2">
            {ordered.map((board) => (
              <li key={board.sessionId}>
                <StatusCard
                  board={board}
                  name={label(board)}
                  open={board === focus || expanded.has(board.sessionId)}
                  focused={board === focus}
                  onToggle={board === focus ? undefined : () => toggle(board.sessionId)}
                />
              </li>
            ))}
          </ol>
        </ScrollArea>
      )}
    </aside>
  )
}

function StatusCard({ board, name, open, focused, onToggle }: {
  board: ListedBoard
  name: string
  open: boolean
  focused: boolean
  onToggle?: () => void
}) {
  const sections = filledSections(board)
  const needsYou = needsYouCount(board)
  const title = board.title ?? sections[0]?.title ?? "Status"
  const summary = (
    <>
      {onToggle && (
        <ChevronRight
          aria-hidden="true"
          className={cn("size-3 shrink-0 text-muted-foreground transition-transform duration-150", open && "rotate-90")}
        />
      )}
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-foreground">{title}</span>
        <span className="text-muted-foreground"> · {name}</span>
      </span>
      {!open && needsYou > 0 && (
        <span className="flex shrink-0 items-center gap-1 font-medium tabular-nums text-warning" aria-label={needsYouLabel(needsYou)}>
          <span aria-hidden="true" className="size-1.5 rounded-full bg-warning" />
          {needsYou}
        </span>
      )}
      {!open && board.progress && (
        <span className="shrink-0 tabular-nums text-muted-foreground">{board.progress.done}/{board.progress.total}</span>
      )}
      <span className="shrink-0 tabular-nums text-muted-foreground/80">{formatRelativeTime(new Date(board.updatedAt).toISOString())}</span>
    </>
  )
  const row = "flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left text-xs"

  return (
    <article
      aria-label={`Status of ${name}`}
      data-status-card={board.sessionId}
      data-focused={focused || undefined}
      className={cn("overflow-hidden rounded-md border", focused ? "border-foreground/20 bg-card" : "border-transparent hover:border-border")}
    >
      <div className="flex items-center">
        {onToggle ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className={cn(row, "rounded-md outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring")}
          >
            {summary}
          </button>
        ) : (
          <div className={row}>{summary}</div>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          className="mr-1 text-muted-foreground"
          onClick={() => void revealSessionById(board.sessionId)}
          aria-label={`Open the conversation of ${name}`}
          title="Open conversation"
        >
          <ArrowUpRight data-icon="inline-start" />
        </Button>
      </div>
      {open && (board.progress || sections.length > 0) && (
        <div className="flex flex-col gap-2 px-2 pb-2 pl-[22px]">
          {board.progress && <Progress done={board.progress.done} total={board.progress.total} />}
          {sections.map((section) => (
            <section key={section.title} aria-label={section.title}>
              <h3 className={cn("mb-0.5 text-[11px] font-medium text-muted-foreground", section.tone && TONE_TEXT[section.tone])}>
                {section.title} <span className="tabular-nums opacity-70">· {section.items.length}</span>
              </h3>
              <ul className="flex flex-col gap-0.5">
                {section.items.map((item, index) => (
                  <li key={index} className="flex min-w-0 gap-1.5 text-xs leading-snug text-foreground/90">
                    <span
                      aria-hidden="true"
                      className={cn("mt-[6px] size-1 shrink-0 rounded-full bg-muted-foreground/50", section.tone && TONE_DOT[section.tone])}
                    />
                    <span className="min-w-0 break-words"><BoardItemText text={item} /></span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </article>
  )
}

function Progress({ done, total }: { done: number; total: number }) {
  const percent = Math.round((done / total) * 100)
  return (
    <span className="flex items-center gap-2 text-[11px] tabular-nums text-muted-foreground">
      <span
        role="progressbar"
        aria-label="Progress"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        className="h-1 flex-1 overflow-hidden rounded-full bg-muted"
      >
        <span className="block h-full rounded-full bg-foreground/80" style={{ width: `${percent}%` }} />
      </span>
      {done}/{total}{done < total && ` · ${total - done} left`}
    </span>
  )
}

/** Re-renders every 30 seconds so "updated 3m ago" stays true. */
function useClockTick(): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((tick) => tick + 1), CLOCK_TICK_MS)
    return () => clearInterval(id)
  }, [])
}
