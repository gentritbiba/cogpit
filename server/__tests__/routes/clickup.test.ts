// @vitest-environment node
import { Readable } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Middleware, UseFn } from "../../http"
import type { ClickUpConfig } from "../../lib/clickupConfig"
import {
  __resetClickUpIdentityCacheForTest,
  ClickUpRouteError,
  parseTask,
  parseTasksPage,
  registerClickUpRoutes,
} from "../../routes/clickup"
import { asIncomingMessage, asServerResponse, getRouteHandler } from "../http-fixtures"

const TOKEN = "pk_12345678_ABCDEFGHIJKLMNOP"

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

function apiFor(responses: Record<string, unknown>) {
  return vi.fn(async (_token: string, path: string) => {
    const key = Object.keys(responses)
      .sort((left, right) => right.length - left.length)
      .find((candidate) => path.startsWith(candidate))
    if (!key) throw new Error(`Unexpected ClickUp call ${path}`)
    const value = responses[key]
    if (value instanceof Error) throw value
    return value
  })
}

function harness(responses: Record<string, unknown>, config: Partial<ClickUpConfig> = {}) {
  const api = apiFor({
    "/user": { user: { id: 7, username: "Gentrit", color: "#123456", initials: "GB" } },
    "/team": { teams: [{ id: 2280762, name: "Honest Digital" }] },
    ...responses,
  })
  const loadConfig = vi.fn(async (): Promise<ClickUpConfig> => ({
    token: TOKEN,
    tokenFromEnv: false,
    projects: {},
    ...config,
  }))
  const saveToken = vi.fn(async () => undefined)
  const saveProjectLink = vi.fn(async () => undefined)
  const resolveProject = vi.fn(async (cwd: string) => (
    cwd === "/repo"
      ? { ok: true as const, projectPath: "/repo", root: "/repo" }
      : { ok: false as const, status: 404, error: "Project directory not found" }
  ))
  const handlers = new Map<string, Middleware>()
  const use: UseFn = (path, handler) => { handlers.set(path, handler) }
  registerClickUpRoutes(use, {
    api,
    loadConfig,
    saveToken,
    saveProjectLink,
    resolveProject,
    now: () => 1_788_400_000_000,
  })
  return { handlers, api, saveToken, saveProjectLink }
}

async function request(handler: Middleware, url: string, method = "GET", body?: unknown) {
  let output = ""
  const response = asServerResponse({
    statusCode: 200,
    setHeader: vi.fn(),
    end: (value?: string) => { output = value ?? "" },
  })
  const next = vi.fn()
  const stream = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
  await handler(asIncomingMessage(Object.assign(stream, { method, url, headers: {} })), response, next)
  return { status: response.statusCode, data: output ? JSON.parse(output) : null, next }
}

afterEach(() => {
  __resetClickUpIdentityCacheForTest()
})

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

describe("ClickUp routes", () => {
  it("reports an unconfigured state without touching ClickUp", async () => {
    const { handlers, api } = harness({}, { token: null })
    const result = await request(getRouteHandler(handlers, "/api/clickup/status"), "/")
    expect(result.status).toBe(200)
    expect(result.data).toEqual({ configured: false, tokenFromEnv: false, viewer: null, workspace: null })
    expect(api).not.toHaveBeenCalled()
  })

  it("reports the viewer and workspace once configured", async () => {
    const { handlers } = harness({})
    const result = await request(getRouteHandler(handlers, "/api/clickup/status"), "/")
    expect(result.data).toEqual({
      configured: true,
      tokenFromEnv: false,
      viewer: { id: 7, username: "Gentrit", initials: "GB", color: "#123456" },
      workspace: { id: "2280762", name: "Honest Digital" },
    })
  })

  it("verifies a submitted token against ClickUp before saving it", async () => {
    const { handlers, saveToken, api } = harness({}, { token: null })
    const handler = getRouteHandler(handlers, "/api/clickup/token")

    const rejected = await request(handler, "/", "POST", { token: "not-a-token" })
    expect(rejected.status).toBe(400)
    expect(saveToken).not.toHaveBeenCalled()

    const accepted = await request(handler, "/", "POST", { token: ` ${TOKEN} ` })
    expect(accepted.status).toBe(200)
    expect(accepted.data.configured).toBe(true)
    expect(saveToken).toHaveBeenCalledWith(TOKEN)
    expect(api).toHaveBeenCalledWith(TOKEN, "/user")

    const forgotten = await request(handler, "/", "DELETE")
    expect(forgotten.data.configured).toBe(false)
    expect(saveToken).toHaveBeenLastCalledWith(null)
  })

  it("refuses to change a token that comes from the environment", async () => {
    const { handlers, saveToken } = harness({}, { tokenFromEnv: true })
    const status = await request(getRouteHandler(handlers, "/api/clickup/status"), "/")
    expect(status.data.tokenFromEnv).toBe(true)

    const handler = getRouteHandler(handlers, "/api/clickup/token")
    expect((await request(handler, "/", "POST", { token: TOKEN })).status).toBe(409)
    expect((await request(handler, "/", "DELETE")).status).toBe(409)
    expect(saveToken).not.toHaveBeenCalled()
  })

  it("forgets the cached identity when the token is replaced", async () => {
    const { handlers, api } = harness({ "/team/2280762/task": { tasks: [], last_page: true } })
    await request(getRouteHandler(handlers, "/api/clickup/tasks/mine"), "/")
    await request(getRouteHandler(handlers, "/api/clickup/token"), "/", "DELETE")
    await request(getRouteHandler(handlers, "/api/clickup/tasks/mine"), "/")
    expect(api.mock.calls.filter(([, path]) => path === "/user")).toHaveLength(2)
  })

  it("asks for a token before loading tasks", async () => {
    const { handlers, api } = harness({}, { token: null })
    const result = await request(getRouteHandler(handlers, "/api/clickup/tasks/mine"), "/")
    expect(result.status).toBe(503)
    expect(result.data.code).toBe("clickup_not_configured")
    expect(api).not.toHaveBeenCalled()
  })

  it("pages through the viewer's assigned tasks and flags a cut-off", async () => {
    const pages = [
      { tasks: [rawTask], last_page: false },
      { tasks: [{ ...rawTask, id: "b" }], last_page: false },
      { tasks: [{ ...rawTask, id: "c" }], last_page: false },
      { tasks: [{ ...rawTask, id: "d" }], last_page: true },
    ]
    const { handlers, api } = harness({})
    api.mockImplementation(async (_token, path) => {
      if (path === "/user") return { user: { id: 7, username: "Gentrit" } }
      if (path === "/team") return { teams: [{ id: 2280762, name: "Honest Digital" }] }
      const page = Number(new URL(`http://x${path}`).searchParams.get("page"))
      expect(path).toContain("/team/2280762/task?assignees[]=7&include_closed=false")
      expect(path).toContain("order_by=due_date&reverse=true")
      return pages[page]
    })

    const result = await request(getRouteHandler(handlers, "/api/clickup/tasks/mine"), "/")
    expect(result.status).toBe(200)
    expect(result.data.tasks.map((task: { id: string }) => task.id)).toEqual(["86c0abc12", "b", "c"])
    expect(result.data.truncated).toBe(true)
    expect(result.data.viewer.id).toBe(7)
  })

  it("resolves identity once per token across requests", async () => {
    const { handlers, api } = harness({ "/team/2280762/task": { tasks: [], last_page: true } })
    const handler = getRouteHandler(handlers, "/api/clickup/tasks/mine")
    await request(handler, "/")
    await request(handler, "/")
    expect(api.mock.calls.filter(([, path]) => path === "/user")).toHaveLength(1)
  })

  it("maps ClickUp failures to stable error codes", async () => {
    const { handlers } = harness({
      "/team/2280762/task": new ClickUpRouteError(401, "clickup_auth_failed", "ClickUp rejected the API token"),
    })
    const result = await request(getRouteHandler(handlers, "/api/clickup/tasks/mine"), "/")
    expect(result.status).toBe(401)
    expect(result.data).toEqual({ error: "ClickUp rejected the API token", code: "clickup_auth_failed" })
  })

  it("tells an unlinked project apart from a missing token", async () => {
    const { handlers } = harness({})
    const result = await request(getRouteHandler(handlers, "/api/clickup/tasks/list"), "/?cwd=/repo")
    expect(result.status).toBe(404)
    expect(result.data.code).toBe("project_unlinked")
  })

  it("loads the linked list with open tasks plus a recently closed tail", async () => {
    const closedTask = {
      ...rawTask,
      id: "closed1",
      status: { status: "complete", color: "#6bc950", type: "closed", orderindex: 3 },
      date_closed: "1788390000000",
    }
    const { handlers, api } = harness({
      "/list/901711539677/task?include_closed=false": { tasks: [rawTask], last_page: true },
      "/list/901711539677/task?include_closed=true": { tasks: [rawTask, closedTask], last_page: false },
      "/list/901711539677": {
        id: "901711539677",
        name: "Sprint 12",
        folder: { id: "90177123201", name: "CMS", hidden: false },
        space: { id: "90171105599" },
        statuses: [
          { status: "complete", type: "closed", orderindex: 3, color: "#6bc950" },
          { status: "to do", type: "open", orderindex: 0, color: "#d3d3d3" },
        ],
      },
    }, { projects: { "/repo": "901711539677" } })

    const result = await request(getRouteHandler(handlers, "/api/clickup/tasks/list"), "/?cwd=/repo")
    expect(result.status).toBe(200)
    expect(result.data.list).toMatchObject({ id: "901711539677", name: "Sprint 12", folderName: "CMS" })
    expect(result.data.list.statuses.map((status: { name: string }) => status.name)).toEqual(["to do", "complete"])
    expect(result.data.tasks.map((task: { id: string }) => task.id)).toEqual(["86c0abc12", "closed1"])
    expect(result.data.truncated).toBe(false)
    const closedCall = api.mock.calls.find(([, path]) => path.includes("include_closed=true"))
    expect(closedCall?.[1]).toContain("date_updated_gt=1787190400000")
    expect(api.mock.calls.some(([, path]) => path.includes("reverse=true"))).toBe(false)
  })

  it("links a project only to a list ClickUp can find", async () => {
    const { handlers, saveProjectLink } = harness({
      "/list/1": new ClickUpRouteError(502, "clickup_api_failed", "ClickUp request failed (404)"),
      "/list/901711539677": { id: "901711539677", name: "Sprint 12", statuses: [] },
    })
    const handler = getRouteHandler(handlers, "/api/clickup/project-list")

    const missing = await request(handler, "/", "PUT", { cwd: "/repo", listId: "1" })
    expect(missing.status).toBe(502)
    expect(saveProjectLink).not.toHaveBeenCalled()

    const linked = await request(handler, "/", "PUT", { cwd: "/repo", listId: "901711539677" })
    expect(linked.status).toBe(200)
    expect(linked.data).toEqual({ cwd: "/repo", listId: "901711539677" })
    expect(saveProjectLink).toHaveBeenCalledWith("/repo", "901711539677")

    const unlinked = await request(handler, "/", "PUT", { cwd: "/repo", listId: null })
    expect(unlinked.data.listId).toBeNull()
    expect(saveProjectLink).toHaveBeenLastCalledWith("/repo", null)

    const elsewhere = await request(handler, "/", "PUT", { cwd: "/missing", listId: null })
    expect(elsewhere.status).toBe(404)
    expect(elsewhere.data.code).toBe("clickup_api_failed")
  })

  it("lists folderless lists before foldered ones for a space", async () => {
    const { handlers } = harness({
      "/space/90171105599/folder": { folders: [{ id: "f1", name: "CMS", lists: [{ id: "2", name: "Sprint" }] }] },
      "/space/90171105599/list": { lists: [{ id: "1", name: "Backlog" }] },
    })
    const result = await request(getRouteHandler(handlers, "/api/clickup/lists"), "/?spaceId=90171105599")
    expect(result.data.lists).toEqual([
      { id: "1", name: "Backlog", folderName: null },
      { id: "2", name: "Sprint", folderName: "CMS" },
    ])
    const bad = await request(getRouteHandler(handlers, "/api/clickup/lists"), "/?spaceId=abc")
    expect(bad.status).toBe(400)
  })
})
