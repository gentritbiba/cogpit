// @vitest-environment node
import { describe, expect, it } from "vitest"
import { ClickUpRouteError, parseTask, parseTasksPage } from "../../routes/clickup"

const rawTask = {
  id: "86c0abc12",
  custom_id: "HSEO-42",
  name: "Fix inventory feed",
  description: "Feed drops **used** vehicles.",
  status: { status: "in progress", color: "#4194f6", type: "custom", orderindex: 1 },
  date_created: "1788300000000",
  date_updated: "1788360000000",
  date_closed: null,
  due_date: "1788400000000",
  start_date: null,
  priority: { id: "2", priority: "high", color: "#ffcc00" },
  assignees: [{ id: 7, username: "Gentrit", color: "#123456", initials: "GB" }],
  tags: [{ name: "seo", tag_bg: "#ff0000" }],
  parent: null,
  list: { id: 901711539677, name: "Sprint 12" },
  folder: { id: "90177123201", name: "CMS", hidden: false },
  space: { id: "90171105599" },
  url: "https://app.clickup.com/t/86c0abc12",
}

describe("ClickUp task parsing", () => {
  it("normalizes a task into the public contract", () => {
    expect(parseTask(rawTask)).toEqual({
      id: "86c0abc12",
      customId: "HSEO-42",
      name: "Fix inventory feed",
      description: "Feed drops **used** vehicles.",
      status: { name: "in progress", type: "custom", color: "#4194f6", order: 1 },
      priority: "high",
      url: "https://app.clickup.com/t/86c0abc12",
      assignees: [{ id: 7, username: "Gentrit", initials: "GB", color: "#123456" }],
      tags: [{ name: "seo", background: "#ff0000" }],
      parentId: null,
      listId: "901711539677",
      listName: "Sprint 12",
      folderName: "CMS",
      spaceId: "90171105599",
      createdAt: 1_788_300_000_000,
      updatedAt: 1_788_360_000_000,
      dueAt: 1_788_400_000_000,
      startAt: null,
      closedAt: null,
    })
  })

  it("treats a hidden folder as no folder and unknown status types as custom", () => {
    const task = parseTask({
      ...rawTask,
      folder: { id: "1", name: "hidden", hidden: true },
      status: { status: "weird", type: "mystery" },
      priority: null,
      custom_id: null,
    })
    expect(task?.folderName).toBeNull()
    expect(task?.status).toMatchObject({ type: "custom", color: "#d3d3d3" })
    expect(task?.priority).toBeNull()
    expect(task?.customId).toBeNull()
  })

  it("rejects a page without a task array", () => {
    expect(() => parseTasksPage({ nope: true })).toThrow(ClickUpRouteError)
  })
})
