import { describe, expect, it } from "vitest"
import type { ClickUpTask } from "../../../shared/contracts/clickup"
import { applyFilters, EMPTY_FILTERS, isOverdue, sortTasks, statusesOf, taskPrompt } from "../filters"

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date(2026, 8, 4, 15, 0).getTime()

function task(overrides: Partial<ClickUpTask>): ClickUpTask {
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    customId: null,
    name: "Task",
    description: "",
    status: { name: "to do", type: "open", color: "#ccc", order: 0 },
    priority: null,
    url: "https://app.clickup.com/t/x",
    assignees: [],
    tags: [],
    parentId: null,
    listId: "1",
    listName: "Sprint",
    folderName: "CMS",
    spaceId: "9",
    createdAt: NOW - 5 * DAY,
    updatedAt: NOW - DAY,
    dueAt: null,
    startAt: null,
    closedAt: null,
    ...overrides,
  }
}

describe("ClickUp task filters", () => {
  it("counts a task as overdue only once its due day has passed", () => {
    const earlierToday = new Date(2026, 8, 4, 9, 0).getTime()
    expect(isOverdue(task({ dueAt: earlierToday }), NOW)).toBe(false)
    expect(isOverdue(task({ dueAt: NOW - DAY }), NOW)).toBe(true)
    expect(isOverdue(task({ dueAt: NOW - DAY, status: { name: "Closed", type: "closed", color: "#0f0", order: 5 } }), NOW)).toBe(false)
    expect(isOverdue(task({ dueAt: NOW - DAY, status: { name: "review", type: "done", color: "#0f0", order: 4 } }), NOW)).toBe(true)
  })

  it("filters by due window, status, priority and free text", () => {
    const overdue = task({ id: "overdue", dueAt: NOW - 2 * DAY, name: "Old feed" })
    const today = task({ id: "today", dueAt: NOW + 60_000, priority: "high" })
    const week = task({ id: "week", dueAt: NOW + 3 * DAY, status: { name: "in progress", type: "custom", color: "#00f", order: 1 } })
    const undated = task({ id: "undated", listName: "Backlog", tags: [{ name: "seo", background: null }] })
    const all = [overdue, today, week, undated]

    const ids = (filters: Partial<typeof EMPTY_FILTERS>) =>
      applyFilters(all, { ...EMPTY_FILTERS, ...filters }, NOW).map((item) => item.id)

    expect(ids({ due: "overdue" })).toEqual(["overdue"])
    expect(applyFilters([task({ id: "done-late", dueAt: NOW - DAY, status: { name: "Closed", type: "closed", color: "#0f0", order: 5 } })], { ...EMPTY_FILTERS, due: "overdue" }, NOW)).toEqual([])
    expect(ids({ due: "today" })).toEqual(["today"])
    expect(ids({ due: "week" })).toEqual(["today", "week"])
    expect(ids({ due: "none" })).toEqual(["undated"])
    expect(ids({ status: "in progress" })).toEqual(["week"])
    expect(ids({ priority: "high" })).toEqual(["today"])
    expect(ids({ query: "backlog" })).toEqual(["undated"])
    expect(ids({ query: "SEO" })).toEqual(["undated"])
    expect(ids({ query: "old" })).toEqual(["overdue"])
  })

  it("orders overdue first, then by due date, priority and recency", () => {
    const sorted = sortTasks([
      task({ id: "recent", updatedAt: NOW }),
      task({ id: "urgent", priority: "urgent", updatedAt: NOW - 3 * DAY }),
      task({ id: "soon", dueAt: NOW + DAY }),
      task({ id: "late", dueAt: NOW - DAY }),
    ], NOW)
    expect(sorted.map((item) => item.id)).toEqual(["late", "soon", "urgent", "recent"])
  })

  it("collects each status once in workflow order", () => {
    const statuses = statusesOf([
      task({ status: { name: "review", type: "custom", color: "#a", order: 2 } }),
      task({ status: { name: "to do", type: "open", color: "#b", order: 0 } }),
      task({ status: { name: "review", type: "custom", color: "#c", order: 2 } }),
    ])
    expect(statuses.map((status) => `${status.name}:${status.color}`)).toEqual(["to do:#b", "review:#a"])
  })

  it("writes a prompt an agent can start from", () => {
    expect(taskPrompt(task({ id: "abc", customId: "HSEO-7", name: "Fix feed", description: "Details\n" })))
      .toBe("Work on ClickUp task HSEO-7: Fix feed\nhttps://app.clickup.com/t/x\n\nDetails")
    expect(taskPrompt(task({ id: "abc", name: "Fix feed" })))
      .toBe("Work on ClickUp task abc: Fix feed\nhttps://app.clickup.com/t/x")
  })
})
