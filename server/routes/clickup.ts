import type { IncomingMessage, ServerResponse } from "node:http"
import type {
  ClickUpErrorCode,
  ClickUpListOption,
  ClickUpListSummary,
  ClickUpListTasksResponse,
  ClickUpListsResponse,
  ClickUpMyTasksResponse,
  ClickUpPriority,
  ClickUpProjectLinkRequest,
  ClickUpProjectLinkResponse,
  ClickUpSpace,
  ClickUpSpacesResponse,
  ClickUpStatus,
  ClickUpStatusResponse,
  ClickUpStatusType,
  ClickUpTag,
  ClickUpTask,
  ClickUpTokenRequest,
  ClickUpUser,
  ClickUpWorkspace,
} from "../../shared/contracts/clickup"
import { readJsonBody, sendJson, type UseFn } from "../http"
import {
  isClickUpToken,
  loadClickUpConfig,
  saveClickUpProjectLink,
  saveClickUpToken,
  type ClickUpConfig,
} from "../lib/clickupConfig"
import { resolveGitProject } from "../lib/gitProject"
import { record, stringValue as text } from "./apiValues"

const API_BASE = "https://api.clickup.com/api/v2"
const REQUEST_TIMEOUT_MS = 20_000
/** ClickUp pages by 100; three pages keeps one panel load under a second. */
const MAX_TASK_PAGES = 3
/** Closed work older than this stays on ClickUp; the fold only needs the recent tail. */
const CLOSED_WINDOW_MS = 14 * 24 * 60 * 60 * 1000
const NUMERIC_ID = /^\d+$/
const STATUS_TYPES = new Set<ClickUpStatusType>(["open", "custom", "closed", "done"])
const PRIORITIES = new Set<ClickUpPriority>(["urgent", "high", "normal", "low"])

export type ClickUpApi = (token: string, path: string) => Promise<unknown>

interface ClickUpDependencies {
  api: ClickUpApi
  loadConfig: () => Promise<ClickUpConfig>
  saveToken: (token: string | null) => Promise<void>
  saveProjectLink: (projectPath: string, listId: string | null) => Promise<void>
  resolveProject: typeof resolveGitProject
  now: () => number
}

export class ClickUpRouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: ClickUpErrorCode,
    message: string,
  ) {
    super(message)
  }
}

function idText(value: unknown): string {
  if (typeof value === "number") return String(value)
  return text(value)
}

function epoch(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/** ClickUp reports a list's implicit folder as hidden; only a real folder names a location. */
function folderNameOf(value: unknown): string | null {
  const folder = record(value)
  return folder && folder.hidden !== true ? text(folder.name) || null : null
}

function invalid(what: string): ClickUpRouteError {
  return new ClickUpRouteError(502, "invalid_response", `ClickUp returned an invalid ${what} response`)
}

export function parseUser(value: unknown): ClickUpUser | null {
  const source = record(value)
  if (!source || typeof source.id !== "number") return null
  const username = text(source.username) || text(source.email)
  return {
    id: source.id,
    username,
    initials: text(source.initials) || username.slice(0, 2).toUpperCase(),
    color: text(source.color) || null,
  }
}

export function parseViewerResponse(value: unknown): ClickUpUser {
  const viewer = parseUser(record(value)?.user)
  if (!viewer) throw invalid("user")
  return viewer
}

/** ClickUp's workspaces, spaces and lists all arrive as the same `{ id, name }` shape. */
function parseNamedEntities(entries: unknown[], fallbackName: string): { id: string; name: string }[] {
  return entries.flatMap((entry) => {
    const source = record(entry)
    const id = idText(source?.id)
    return source && NUMERIC_ID.test(id) ? [{ id, name: text(source.name, fallbackName) }] : []
  })
}

export function parseWorkspacesResponse(value: unknown): ClickUpWorkspace[] {
  const teams = record(value)?.teams
  if (!Array.isArray(teams)) throw invalid("workspace")
  return parseNamedEntities(teams, "Workspace")
}

function parseStatus(value: unknown): ClickUpStatus | null {
  const source = record(value)
  if (!source) return null
  const name = text(source.status)
  if (!name) return null
  const type = text(source.type)
  return {
    name,
    type: STATUS_TYPES.has(type as ClickUpStatusType) ? type as ClickUpStatusType : "custom",
    color: text(source.color, "#d3d3d3"),
    order: typeof source.orderindex === "number" ? source.orderindex : 0,
  }
}

function parseTag(value: unknown): ClickUpTag | null {
  const source = record(value)
  const name = text(source?.name)
  return name ? { name, background: text(source?.tag_bg) || null } : null
}

function parsePriority(value: unknown): ClickUpPriority | null {
  const name = text(record(value)?.priority)
  return PRIORITIES.has(name as ClickUpPriority) ? name as ClickUpPriority : null
}

export function parseTask(value: unknown): ClickUpTask | null {
  const source = record(value)
  if (!source) return null
  const id = text(source.id)
  const status = parseStatus(source.status)
  const list = record(source.list)
  if (!id || !status || !list) return null
  const customId = text(source.custom_id)
  return {
    id,
    customId: customId || null,
    name: text(source.name, "Untitled task"),
    description: text(source.markdown_description) || text(source.description),
    status,
    priority: parsePriority(source.priority),
    url: text(source.url) || `https://app.clickup.com/t/${id}`,
    assignees: Array.isArray(source.assignees)
      ? source.assignees.map(parseUser).filter((user): user is ClickUpUser => user !== null)
      : [],
    tags: Array.isArray(source.tags)
      ? source.tags.map(parseTag).filter((tag): tag is ClickUpTag => tag !== null)
      : [],
    parentId: text(source.parent) || null,
    listId: idText(list.id),
    listName: text(list.name, "List"),
    folderName: folderNameOf(source.folder),
    spaceId: idText(record(source.space)?.id),
    createdAt: epoch(source.date_created) ?? 0,
    updatedAt: epoch(source.date_updated) ?? epoch(source.date_created) ?? 0,
    dueAt: epoch(source.due_date),
    startAt: epoch(source.start_date),
    closedAt: epoch(source.date_closed) ?? epoch(source.date_done),
  }
}

export function parseTasksPage(value: unknown): { tasks: ClickUpTask[]; lastPage: boolean } {
  const source = record(value)
  if (!source || !Array.isArray(source.tasks)) throw invalid("task list")
  return {
    tasks: source.tasks.map(parseTask).filter((task): task is ClickUpTask => task !== null),
    lastPage: source.last_page !== false,
  }
}

export function parseListResponse(value: unknown): ClickUpListSummary {
  const source = record(value)
  const id = idText(source?.id)
  if (!source || !NUMERIC_ID.test(id)) throw invalid("list")
  const statuses = Array.isArray(source.statuses)
    ? source.statuses.map(parseStatus).filter((status): status is ClickUpStatus => status !== null)
    : []
  return {
    id,
    name: text(source.name, "List"),
    folderName: folderNameOf(source.folder),
    spaceId: idText(record(source.space)?.id),
    statuses: statuses.sort((left, right) => left.order - right.order),
    url: `https://app.clickup.com/v/li/${id}`,
  }
}

export function parseSpacesResponse(value: unknown): ClickUpSpace[] {
  const spaces = record(value)?.spaces
  if (!Array.isArray(spaces)) throw invalid("space")
  return parseNamedEntities(spaces, "Space")
}

function parseListOptions(value: unknown, folderName: string | null): ClickUpListOption[] {
  if (!Array.isArray(value)) return []
  return parseNamedEntities(value, "List").map((list) => ({ ...list, folderName }))
}

export function parseFoldersResponse(value: unknown): ClickUpListOption[] {
  const folders = record(value)?.folders
  if (!Array.isArray(folders)) throw invalid("folder")
  return folders.flatMap((folder) => {
    const source = record(folder)
    return source ? parseListOptions(source.lists, text(source.name) || null) : []
  })
}

export function parseFolderlessListsResponse(value: unknown): ClickUpListOption[] {
  const source = record(value)
  if (!source || !Array.isArray(source.lists)) throw invalid("list")
  return parseListOptions(source.lists, null)
}

export async function runClickUpApi(token: string, path: string): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: token, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    throw new ClickUpRouteError(502, "clickup_api_failed", "ClickUp is unreachable")
  }
  if (response.status === 401) {
    throw new ClickUpRouteError(401, "clickup_auth_failed", "ClickUp rejected the API token")
  }
  if (response.status === 429) {
    throw new ClickUpRouteError(429, "clickup_rate_limited", "ClickUp rate limit reached; try again in a minute")
  }
  if (!response.ok) {
    throw new ClickUpRouteError(502, "clickup_api_failed", `ClickUp request failed (${response.status})`)
  }
  try {
    return await response.json() as unknown
  } catch {
    throw invalid("JSON")
  }
}

const defaultDependencies: ClickUpDependencies = {
  api: runClickUpApi,
  loadConfig: loadClickUpConfig,
  saveToken: saveClickUpToken,
  saveProjectLink: saveClickUpProjectLink,
  resolveProject: resolveGitProject,
  now: () => Date.now(),
}

interface Identity {
  token: string
  viewer: ClickUpUser
  workspace: ClickUpWorkspace
}

/**
 * Who the token belongs to and which workspace it opens. Cached per token so
 * every poll does not spend two of ClickUp's hundred requests a minute on it.
 */
const identityCache = new Map<string, Promise<Identity>>()

function identityFor(token: string, deps: ClickUpDependencies): Promise<Identity> {
  let cached = identityCache.get(token)
  if (!cached) {
    cached = (async () => {
      const [viewer, workspaces] = await Promise.all([
        deps.api(token, "/user").then(parseViewerResponse),
        deps.api(token, "/team").then(parseWorkspacesResponse),
      ])
      const workspace = workspaces[0]
      if (!workspace) throw new ClickUpRouteError(502, "clickup_api_failed", "The token belongs to no ClickUp workspace")
      return { token, viewer, workspace }
    })()
    identityCache.set(token, cached)
    cached.catch(() => identityCache.delete(token))
  }
  return cached
}

async function requireIdentity(deps: ClickUpDependencies): Promise<Identity & { config: ClickUpConfig }> {
  const config = await deps.loadConfig()
  if (!config.token) {
    throw new ClickUpRouteError(503, "clickup_not_configured", "Add a ClickUp API token to view your tasks")
  }
  return { ...(await identityFor(config.token, deps)), config }
}

async function statusFor(config: ClickUpConfig, deps: ClickUpDependencies): Promise<ClickUpStatusResponse> {
  if (!config.token) return { configured: false, tokenFromEnv: false, viewer: null, workspace: null }
  const identity = await identityFor(config.token, deps)
  return { configured: true, tokenFromEnv: config.tokenFromEnv, viewer: identity.viewer, workspace: identity.workspace }
}

async function fetchTaskPages(
  token: string,
  path: string,
  deps: ClickUpDependencies,
  maxPages = MAX_TASK_PAGES,
): Promise<{ tasks: ClickUpTask[]; truncated: boolean }> {
  const tasks: ClickUpTask[] = []
  for (let page = 0; page < maxPages; page += 1) {
    const result = parseTasksPage(await deps.api(token, `${path}&page=${page}`))
    tasks.push(...result.tasks)
    if (result.lastPage) return { tasks, truncated: false }
  }
  return { tasks, truncated: true }
}

async function resolveProjectPath(cwd: string, deps: ClickUpDependencies): Promise<string> {
  const project = await deps.resolveProject(cwd)
  if (!project.ok) throw new ClickUpRouteError(project.status, "clickup_api_failed", project.error)
  return project.projectPath
}

function sendRouteError(res: ServerResponse, error: unknown): void {
  if (error instanceof ClickUpRouteError) {
    sendJson(res, error.status, { error: error.message, code: error.code })
    return
  }
  sendJson(res, 500, { error: "Unable to load ClickUp data", code: "clickup_api_failed" })
}

type RouteHandler = (req: IncomingMessage, url: URL) => Promise<{ status: number; body: unknown }>

function route(use: UseFn, path: string, methods: string[], handler: RouteHandler): void {
  use(path, async (req, res, next) => {
    if (!methods.includes(req.method ?? "")) return next()
    const url = new URL(req.url || "", "http://localhost")
    if (url.pathname !== "/" && url.pathname !== "") return next()
    try {
      const result = await handler(req, url)
      sendJson(res, result.status, result.body)
    } catch (error) {
      sendRouteError(res, error)
    }
  })
}

export function __resetClickUpIdentityCacheForTest(): void {
  identityCache.clear()
}

export function registerClickUpRoutes(use: UseFn, deps: ClickUpDependencies = defaultDependencies): void {
  route(use, "/api/clickup/status", ["GET"], async () => ({
    status: 200,
    body: await statusFor(await deps.loadConfig(), deps),
  }))

  route(use, "/api/clickup/token", ["POST", "DELETE"], async (req) => {
    const current = await deps.loadConfig()
    if (current.tokenFromEnv) {
      throw new ClickUpRouteError(409, "clickup_api_failed", "The ClickUp token comes from the server environment; change it there")
    }
    if (current.token) identityCache.delete(current.token)
    if (req.method === "DELETE") {
      await deps.saveToken(null)
      return { status: 200, body: await statusFor({ ...current, token: null }, deps) }
    }
    const { token } = await readJsonBody<Partial<ClickUpTokenRequest>>(req)
    const candidate = typeof token === "string" ? token.trim() : ""
    if (!isClickUpToken(candidate)) {
      throw new ClickUpRouteError(400, "clickup_auth_failed", "That does not look like a ClickUp personal API token (pk_…)")
    }
    await identityFor(candidate, deps)
    await deps.saveToken(candidate)
    return { status: 200, body: await statusFor({ ...current, token: candidate }, deps) }
  })

  route(use, "/api/clickup/tasks/mine", ["GET"], async () => {
    const { token, viewer, workspace } = await requireIdentity(deps)
    // ClickUp sorts descending unless reversed; soonest due first is what the panel needs.
    const path = `/team/${workspace.id}/task?assignees[]=${viewer.id}&include_closed=false&subtasks=true&order_by=due_date&reverse=true`
    const { tasks, truncated } = await fetchTaskPages(token, path, deps)
    const body: ClickUpMyTasksResponse = { workspace, viewer, tasks, truncated }
    return { status: 200, body }
  })

  route(use, "/api/clickup/tasks/list", ["GET"], async (_req, url) => {
    const projectPath = await resolveProjectPath(url.searchParams.get("cwd") ?? "", deps)
    const { token, viewer, workspace, config } = await requireIdentity(deps)
    const listId = config.projects[projectPath]
    if (!listId) throw new ClickUpRouteError(404, "project_unlinked", "This project is not linked to a ClickUp list")

    const since = deps.now() - CLOSED_WINDOW_MS
    const [list, open, closed] = await Promise.all([
      deps.api(token, `/list/${listId}`).then(parseListResponse),
      fetchTaskPages(token, `/list/${listId}/task?include_closed=false&subtasks=true&order_by=updated`, deps),
      fetchTaskPages(token, `/list/${listId}/task?include_closed=true&subtasks=true&order_by=updated&date_updated_gt=${since}`, deps, 1),
    ])
    const seen = new Set(open.tasks.map((task) => task.id))
    const recentlyClosed = closed.tasks.filter((task) => !seen.has(task.id) && task.status.type === "closed")
    const body: ClickUpListTasksResponse = {
      workspace,
      viewer,
      list,
      tasks: [...open.tasks, ...recentlyClosed],
      truncated: open.truncated,
    }
    return { status: 200, body }
  })

  route(use, "/api/clickup/spaces", ["GET"], async () => {
    const { token, workspace } = await requireIdentity(deps)
    const spaces = parseSpacesResponse(await deps.api(token, `/team/${workspace.id}/space?archived=false`))
    const body: ClickUpSpacesResponse = { workspace, spaces }
    return { status: 200, body }
  })

  route(use, "/api/clickup/lists", ["GET"], async (_req, url) => {
    const spaceId = url.searchParams.get("spaceId") ?? ""
    if (!NUMERIC_ID.test(spaceId)) {
      throw new ClickUpRouteError(400, "clickup_api_failed", "spaceId must be a ClickUp space id")
    }
    const { token } = await requireIdentity(deps)
    const [inFolders, folderless] = await Promise.all([
      deps.api(token, `/space/${spaceId}/folder?archived=false`).then(parseFoldersResponse),
      deps.api(token, `/space/${spaceId}/list?archived=false`).then(parseFolderlessListsResponse),
    ])
    const body: ClickUpListsResponse = { spaceId, lists: [...folderless, ...inFolders] }
    return { status: 200, body }
  })

  route(use, "/api/clickup/project-list", ["GET", "PUT"], async (req, url) => {
    if (req.method === "GET") {
      const projectPath = await resolveProjectPath(url.searchParams.get("cwd") ?? "", deps)
      const config = await deps.loadConfig()
      const body: ClickUpProjectLinkResponse = { cwd: projectPath, listId: config.projects[projectPath] ?? null }
      return { status: 200, body }
    }
    const request = await readJsonBody<Partial<ClickUpProjectLinkRequest>>(req)
    const projectPath = await resolveProjectPath(typeof request.cwd === "string" ? request.cwd : "", deps)
    const listId = request.listId === null || request.listId === undefined ? null : String(request.listId)
    if (listId !== null && !NUMERIC_ID.test(listId)) {
      throw new ClickUpRouteError(400, "clickup_api_failed", "listId must be a ClickUp list id")
    }
    if (listId !== null) {
      const { token } = await requireIdentity(deps)
      parseListResponse(await deps.api(token, `/list/${listId}`))
    }
    await deps.saveProjectLink(projectPath, listId)
    const body: ClickUpProjectLinkResponse = { cwd: projectPath, listId }
    return { status: 200, body }
  })
}
