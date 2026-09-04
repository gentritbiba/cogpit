import type { ClickUpPriority, ClickUpStatus, ClickUpTask } from "../../shared/contracts/clickup"

export type DueFilter = "all" | "overdue" | "today" | "week" | "none"

export interface TaskFilters {
  status: string | null
  due: DueFilter
  priority: ClickUpPriority | null
  query: string
}

export const EMPTY_FILTERS: TaskFilters = { status: null, due: "all", priority: null, query: "" }

export const PRIORITY_ORDER: Record<ClickUpPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 }

const DAY_MS = 24 * 60 * 60 * 1000

/** ClickUp's `done` type is still a live workflow step (a "review" column, say); only `closed` is finished. */
export function isFinished(task: ClickUpTask): boolean {
  return task.status.type === "closed"
}

function startOfDay(now: number): number {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** Overdue means the due day has passed, not the due minute: ClickUp dates are usually day-granular. */
export function isOverdue(task: ClickUpTask, now: number): boolean {
  return task.dueAt !== null && !isFinished(task) && task.dueAt < startOfDay(now)
}

export function matchesDue(task: ClickUpTask, due: DueFilter, now: number): boolean {
  if (due === "all") return true
  if (due === "none") return task.dueAt === null
  if (task.dueAt === null) return false
  const today = startOfDay(now)
  switch (due) {
    case "overdue":
      return isOverdue(task, now)
    case "today":
      return task.dueAt >= today && task.dueAt < today + DAY_MS
    case "week":
      return task.dueAt >= today && task.dueAt < today + 7 * DAY_MS
  }
}

export function matchesQuery(task: ClickUpTask, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [task.name, task.customId ?? "", task.listName, task.folderName ?? "", ...task.tags.map((tag) => tag.name)]
    .some((field) => field.toLowerCase().includes(needle))
}

export function applyFilters(tasks: ClickUpTask[], filters: TaskFilters, now: number): ClickUpTask[] {
  return tasks.filter((task) => (
    (filters.status === null || task.status.name === filters.status)
    && (filters.priority === null || task.priority === filters.priority)
    && matchesDue(task, filters.due, now)
    && matchesQuery(task, filters.query)
  ))
}

/**
 * Statuses worth a chip: those present in the tasks, in workflow order. Lists
 * share status names across the workspace, so the first seen colour stands
 * for all of them.
 */
export function statusesOf(tasks: ClickUpTask[]): ClickUpStatus[] {
  const seen = new Map<string, ClickUpStatus>()
  for (const task of tasks) {
    if (!seen.has(task.status.name)) seen.set(task.status.name, task.status)
  }
  return [...seen.values()].sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))
}

/** Overdue first, then by due date, then by priority, then most recently updated. */
export function sortTasks(tasks: ClickUpTask[], now: number): ClickUpTask[] {
  return [...tasks].sort((left, right) => {
    const overdue = Number(isOverdue(right, now)) - Number(isOverdue(left, now))
    if (overdue !== 0) return overdue
    if (left.dueAt !== right.dueAt) {
      if (left.dueAt === null) return 1
      if (right.dueAt === null) return -1
      return left.dueAt - right.dueAt
    }
    const priority = (left.priority ? PRIORITY_ORDER[left.priority] : 4) - (right.priority ? PRIORITY_ORDER[right.priority] : 4)
    if (priority !== 0) return priority
    return right.updatedAt - left.updatedAt
  })
}

/** Where a task or list sits in ClickUp: `Folder › List`, or just the list. */
export function locationLabel(folderName: string | null, name: string): string {
  return folderName ? `${folderName} › ${name}` : name
}

/** The prompt handed to an agent: enough to start work without opening ClickUp. */
export function taskPrompt(task: ClickUpTask): string {
  const reference = task.customId ?? task.id
  const description = task.description.trim()
  return [
    `Work on ClickUp task ${reference}: ${task.name}`,
    task.url,
    ...(description ? ["", description] : []),
  ].join("\n")
}
