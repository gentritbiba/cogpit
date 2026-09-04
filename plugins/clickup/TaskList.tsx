import { useState } from "react"
import {
  ArrowUpRight,
  CalendarClock,
  CircleDashed,
  Flag,
  MessageSquarePlus,
  Search,
  X,
} from "lucide-react"
import type { ClickUpPriority, ClickUpTask, ClickUpUser } from "../../shared/contracts/clickup"
import {
  Button,
  ClosedFold,
  cn,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Description,
  FilterBar,
  FilterChip,
  FilterChipCount,
  Input,
  relativeTime,
  ScrollArea,
  TabEmpty,
  useNow,
} from "@/plugin-api"
import {
  applyFilters,
  EMPTY_FILTERS,
  isFinished,
  isOverdue,
  locationLabel,
  matchesDue,
  sortTasks,
  statusesOf,
  taskPrompt,
  type DueFilter,
  type TaskFilters,
} from "./filters"

const PRIORITY_CLASS: Record<ClickUpPriority, string> = {
  urgent: "text-destructive",
  high: "text-warning",
  normal: "text-info",
  low: "text-muted-foreground",
}

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" })

function PriorityFlag({ priority }: { priority: ClickUpPriority | null }) {
  if (!priority) return null
  return (
    <Flag
      className={cn("size-3 shrink-0", PRIORITY_CLASS[priority])}
      aria-label={`${priority} priority`}
      role="img"
      fill="currentColor"
    />
  )
}

function DueDate({ task, now }: { task: ClickUpTask; now: number }) {
  if (task.dueAt === null) return null
  const overdue = isOverdue(task, now)
  const label = `Due ${new Date(task.dueAt).toLocaleDateString()}`
  return (
    <time
      className={cn("flex shrink-0 items-center gap-0.5 text-[10px] tabular-nums", overdue ? "text-destructive" : "text-muted-foreground")}
      dateTime={new Date(task.dueAt).toISOString()}
      title={overdue ? `${label} (overdue)` : label}
    >
      <CalendarClock className="size-3" aria-hidden />
      {DATE_FORMAT.format(task.dueAt)}
    </time>
  )
}

function Assignees({ assignees, viewer }: { assignees: ClickUpUser[]; viewer: ClickUpUser }) {
  const others = assignees.filter((user) => user.id !== viewer.id)
  if (others.length === 0) return null
  const label = `Also assigned to ${others.map((user) => user.username).join(", ")}`
  return (
    <span className="flex shrink-0 -space-x-1" aria-label={label} title={label}>
      {others.slice(0, 3).map((user) => (
        <span
          key={user.id}
          className="flex size-4 items-center justify-center rounded-full border border-background text-[8px] font-medium text-white"
          style={{ backgroundColor: user.color ?? "#6b7280" }}
          aria-hidden
        >
          {user.initials.slice(0, 2)}
        </span>
      ))}
    </span>
  )
}

function TaskRow({
  task,
  viewer,
  now,
  onPickStatus,
  composePrompt,
}: {
  task: ClickUpTask
  viewer: ClickUpUser
  now: number
  onPickStatus: (status: string) => void
  composePrompt: ((text: string) => void) | undefined
}) {
  const [open, setOpen] = useState(false)
  const finished = isFinished(task)
  const description = task.description.trim()
  const location = locationLabel(task.folderName, task.listName)

  return (
    <article className="relative pl-3" aria-label={task.name}>
      <span aria-hidden className="absolute inset-y-1 left-0 w-0.5 rounded-full" style={{ backgroundColor: task.status.color }} />
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="group/task flex items-start gap-1 pr-1">
          <CollapsibleTrigger
            className="flex min-w-0 flex-1 flex-col rounded-sm px-1 py-1 text-left outline-none hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/20"
            aria-label={`${task.name}: ${task.status.name}`}
            aria-expanded={open}
          >
            <span className="flex min-w-0 items-center gap-2">
              <PriorityFlag priority={task.priority} />
              <span className={cn("min-w-0 flex-1 truncate text-[13px] font-medium leading-5", finished && "text-muted-foreground line-through decoration-border")}>
                {task.name}
              </span>
              {task.customId && <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{task.customId}</span>}
            </span>
            <span className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
              <span className="shrink-0 rounded-sm px-1 text-[10px] uppercase tracking-wide" style={{ color: task.status.color }}>
                {task.status.name}
              </span>
              <span className="truncate">{location}</span>
              <span className="shrink-0">·</span>
              <time className="shrink-0" dateTime={new Date(task.updatedAt).toISOString()} title={new Date(task.updatedAt).toLocaleString()}>
                {relativeTime(new Date(task.updatedAt).toISOString(), now)}
              </time>
            </span>
          </CollapsibleTrigger>
          <div className="mt-1 flex shrink-0 items-center gap-1.5">
            <DueDate task={task} now={now} />
            <Assignees assignees={task.assignees} viewer={viewer} />
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="size-6 text-muted-foreground opacity-0 transition-opacity group-hover/task:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
              aria-label={`Open ${task.customId ?? task.name} in ClickUp`}
              onClick={() => window.open(task.url, "_blank", "noopener,noreferrer")}
            >
              <ArrowUpRight />
            </Button>
          </div>
        </div>
        <CollapsibleContent>
          <div className="flex flex-col gap-3 py-2 pl-1 pr-1">
            {description ? <Description body={description} /> : <p className="text-xs leading-5 text-muted-foreground">No description.</p>}

            <ul className="flex flex-wrap gap-1" aria-label="Task details">
              <li>
                <button
                  type="button"
                  className="inline-flex h-5 items-center gap-1 rounded-full border px-1.5 text-[10px] leading-none text-muted-foreground outline-none hover:border-foreground/30 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/20"
                  onClick={() => onPickStatus(task.status.name)}
                  aria-label={`Only tasks in ${task.status.name}`}
                >
                  <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: task.status.color }} />
                  {task.status.name}
                </button>
              </li>
              {task.tags.map((tag) => (
                <li key={tag.name} className="inline-flex h-5 items-center rounded-full border px-1.5 text-[10px] leading-none text-muted-foreground">
                  {tag.name}
                </li>
              ))}
            </ul>

            <div className="flex flex-wrap gap-2">
              {composePrompt && (
                <Button type="button" size="xs" onClick={() => composePrompt(taskPrompt(task))}>
                  <MessageSquarePlus data-icon="inline-start" />
                  Add to prompt
                </Button>
              )}
              <Button variant="outline" size="xs" render={<a href={task.url} target="_blank" rel="noopener noreferrer" />}>
                Open in ClickUp
                <ArrowUpRight data-icon="inline-end" />
              </Button>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </article>
  )
}

export function TaskList({
  tasks,
  viewer,
  composePrompt,
  emptyTitle,
  emptyDescription,
  truncated,
}: {
  tasks: ClickUpTask[]
  viewer: ClickUpUser
  composePrompt: ((text: string) => void) | undefined
  emptyTitle: string
  emptyDescription: string
  truncated: boolean
}) {
  const [filters, setFilters] = useState<TaskFilters>(EMPTY_FILTERS)
  const now = useNow(false)

  if (tasks.length === 0) {
    return <TabEmpty icon={CircleDashed} title={emptyTitle} description={emptyDescription} />
  }

  const active = tasks.filter((task) => !isFinished(task))
  const statuses = statusesOf(active)
  const priorities = [...new Set(active.flatMap((task) => task.priority ? [task.priority] : []))]
  const dueCount = (due: DueFilter) => active.filter((task) => matchesDue(task, due, now)).length
  const overdue = dueCount("overdue")
  const today = dueCount("today")
  const week = dueCount("week")
  const visible = applyFilters(tasks, filters, now)
  const open = sortTasks(visible.filter((task) => !isFinished(task)), now)
  const closed = visible.filter(isFinished).sort((left, right) => (right.closedAt ?? right.updatedAt) - (left.closedAt ?? left.updatedAt))
  const set = (patch: Partial<TaskFilters>) => setFilters((current) => ({ ...current, ...patch }))
  const filtered = filters.status !== null || filters.due !== "all" || filters.priority !== null || filters.query.trim() !== ""

  const row = (task: ClickUpTask) => (
    <TaskRow
      key={task.id}
      task={task}
      viewer={viewer}
      now={now}
      onPickStatus={(status) => set({ status })}
      composePrompt={composePrompt}
    />
  )

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <Input
          type="search"
          value={filters.query}
          onChange={(event) => set({ query: event.target.value })}
          placeholder="Search tasks"
          aria-label="Search tasks"
          className="h-7 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
        />
        {filtered && (
          <Button type="button" variant="ghost" size="xs" onClick={() => setFilters(EMPTY_FILTERS)} aria-label="Clear filters">
            <X data-icon="inline-start" />
            Clear
          </Button>
        )}
      </div>
      <FilterBar label="Filter by due date and priority">
        <FilterChip pressed={filters.due === "all"} onClick={() => set({ due: "all" })}>
          All
          <FilterChipCount>{active.length}</FilterChipCount>
        </FilterChip>
        <FilterChip pressed={filters.due === "overdue"} disabled={overdue === 0} onClick={() => set({ due: "overdue" })} className={overdue > 0 && filters.due !== "overdue" ? "text-destructive" : undefined}>
          Overdue
          <FilterChipCount>{overdue}</FilterChipCount>
        </FilterChip>
        <FilterChip pressed={filters.due === "today"} disabled={today === 0} onClick={() => set({ due: "today" })}>
          Today
          <FilterChipCount>{today}</FilterChipCount>
        </FilterChip>
        <FilterChip pressed={filters.due === "week"} disabled={week === 0} onClick={() => set({ due: "week" })}>
          This week
          <FilterChipCount>{week}</FilterChipCount>
        </FilterChip>
        {priorities.length > 0 && <span className="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden />}
        {priorities.map((priority) => (
          <FilterChip
            key={priority}
            pressed={filters.priority === priority}
            onClick={() => set({ priority: filters.priority === priority ? null : priority })}
            aria-label={`Only ${priority} priority tasks`}
          >
            <PriorityFlag priority={priority} />
            {priority}
            <FilterChipCount>{active.filter((task) => task.priority === priority).length}</FilterChipCount>
          </FilterChip>
        ))}
      </FilterBar>
      {statuses.length > 1 && (
        <FilterBar label="Filter by status">
          {statuses.map((status) => (
            <FilterChip
              key={status.name}
              pressed={filters.status === status.name}
              onClick={() => set({ status: filters.status === status.name ? null : status.name })}
              aria-label={`Only tasks in ${status.name}`}
            >
              <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: status.color }} />
              {status.name}
              <FilterChipCount>{active.filter((task) => task.status.name === status.name).length}</FilterChipCount>
            </FilterChip>
          ))}
        </FilterBar>
      )}
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 px-3 py-3">
          {open.length === 0 ? (
            <p className="px-1 py-3 text-center text-xs text-muted-foreground">
              {filtered ? "No tasks match these filters." : "Nothing open here."}
            </p>
          ) : (
            open.map(row)
          )}
          {closed.length > 0 && <ClosedFold count={closed.length}>{closed.map(row)}</ClosedFold>}
          {truncated && (
            <p className="px-1 text-center text-[11px] text-muted-foreground">
              Showing the first {tasks.length} tasks; narrow it down in ClickUp to see the rest.
            </p>
          )}
        </div>
      </ScrollArea>
    </>
  )
}
