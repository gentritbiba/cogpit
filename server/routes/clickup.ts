import { ClickUpDataError as ClickUpRouteError, parseViewerResponse, parseTasksPage, parseListResponse } from "@cogpit/plugin-integrations/normalizeClickUp"
export {
  ClickUpDataError as ClickUpRouteError,
  parseUser,
  parseViewerResponse,
  parseWorkspacesResponse,
  parseTask,
  parseTasksPage,
  parseListResponse,
  parseSpacesResponse,
  parseFoldersResponse,
  parseFolderlessListsResponse,
} from "@cogpit/plugin-integrations/normalizeClickUp"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { ClickUpStatusResponse, ClickUpTask } from "../../shared/contracts/clickup"
import { z } from "zod"
import { readJsonBody, sendJson, type UseFn } from "../http"
import { isClickUpToken } from "../lib/clickupConfig"
import { getPluginManager, type PluginManager, type LegacyPluginCaller } from "../plugins/manager"
import { PluginDataError } from "../plugins/privateStore"

const PLUGIN = "cogpit.clickup"
const CONNECTION = "clickup"
const CLOSED_WINDOW_MS = 14 * 24 * 60 * 60 * 1000
interface ClickUpDependencies { manager: () => PluginManager | null; now: () => number }
const defaults: ClickUpDependencies = { manager: getPluginManager, now: Date.now }
const address = (caller: LegacyPluginCaller) => ({ pluginId: PLUGIN, projectId: caller.projectId, connectionId: CONNECTION })

function sendRouteError(res: ServerResponse, error: unknown): void {
  if (error instanceof ClickUpRouteError) { sendJson(res, error.status, { error: error.message, code: error.code }); return }
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined
  const [status, publicCode, message] = code === "CONNECTION_REQUIRED" ? [503, "clickup_not_configured", "Connect ClickUp in plugin settings"]
    : code === "RESOURCE_REQUIRED" ? [404, "project_unlinked", "Select a ClickUp workspace and project list"]
    : code === "RATE_LIMITED" ? [429, "clickup_rate_limited", "Too many ClickUp requests; try again shortly"]
    : code === "INVALID_REQUEST" ? [400, "clickup_api_failed", "Invalid ClickUp request"]
    : code === "PERMISSION_REQUIRED" || code === "STALE_ACTIVATION" || code === "CANCELED" ? [409, "clickup_api_failed", "ClickUp is disabled, unavailable, or its permissions changed"]
    : [502, "clickup_api_failed", "Unable to load ClickUp data"]
  sendJson(res, status as number, { code: publicCode, error: message })
}
async function snapshot(manager: PluginManager, caller: LegacyPluginCaller) {
  const value = await manager.listConnections(caller.request, address(caller), caller.options)
  const connection = value.connections.find(connection => connection.id === CONNECTION)
  if (!connection) throw new PluginDataError("PERMISSION_REQUIRED", "ClickUp connection is unavailable")
  return { ...value, connection }
}
async function ensureWorkspace(manager: PluginManager, caller: LegacyPluginCaller): Promise<void> {
  const value = await snapshot(manager, caller)
  if (value.connection.status === "disconnected" || value.connection.selected.workspace) return
  const workspaces = await manager.listResourceOptions(caller.request, { ...address(caller), resourceId: "workspace" }, caller.options)
  if (!workspaces[0]) throw new PluginDataError("RESOURCE_REQUIRED", "Choose a ClickUp workspace")
  await manager.selectResource(caller.request, { ...address(caller), resourceId: "workspace", value: workspaces[0].id, expectedRevision: value.revision }, caller.options)
}
async function statusFor(manager: PluginManager, caller: LegacyPluginCaller): Promise<ClickUpStatusResponse> {
  await ensureWorkspace(manager, caller)
  const value = (await snapshot(manager, caller)).connection
  if (value.status === "disconnected") return { configured: false, tokenFromEnv: false, viewer: null, workspace: null }
  const workspace = value.selected.workspace
  return { configured: true, tokenFromEnv: value.readOnly, viewer: parseViewerResponse(await caller.call("viewer", {})), workspace: workspace ? { id: workspace.id, name: workspace.label } : null }
}
async function identity(manager: PluginManager, caller: LegacyPluginCaller) {
  const status = await statusFor(manager, caller)
  if (!status.configured) throw new PluginDataError("CONNECTION_REQUIRED", "Configure ClickUp")
  if (!status.viewer || !status.workspace) throw new PluginDataError("RESOURCE_REQUIRED", "Choose a ClickUp workspace")
  return { viewer: status.viewer, workspace: status.workspace }
}
async function pages(caller: LegacyPluginCaller, operation: string, args: Record<string, string | number | boolean>, limit = 3) {
  const tasks = new Map<string, ClickUpTask>()
  for (let page = 0; page < limit; page++) {
    const result = parseTasksPage(await caller.call(operation, { ...args, page }))
    for (const task of result.tasks) tasks.set(task.id, task)
    if (result.lastPage) return { tasks: [...tasks.values()], truncated: false }
  }
  return { tasks: [...tasks.values()], truncated: true }
}

type Handler = (manager: PluginManager, caller: LegacyPluginCaller, req: IncomingMessage, url: URL, body: unknown) => Promise<unknown>
export function registerClickUpRoutes(use: UseFn, deps: ClickUpDependencies = defaults): void {
  const route = (path: string, methods: string[], handler: Handler, project = false) => use(`/api/clickup/${path}`, async (req, res, next) => {
    const url = new URL(req.url || "", "http://localhost")
    if (!methods.includes(req.method ?? "") || url.pathname !== "/" && url.pathname !== "") return next()
    const controller = new AbortController(), socket = req.socket
    const abort = () => { if (!res.writableFinished) controller.abort() }
    req.on("aborted", abort); res.on?.("close", abort)
    try {
      const manager = deps.manager()
      if (!manager) throw new PluginDataError("STALE_ACTIVATION", "Runtime plugins are unavailable")
      const body: unknown = req.method === "POST" || req.method === "PUT" ? await readJsonBody(req, { maxBytes: 8192 }) : undefined
      const cwd = project ? req.method === "PUT" ? z.strictObject({ cwd: z.string().min(1).max(4096), listId: z.string().regex(/^\d{1,128}$/).nullable() }).parse(body).cwd : url.searchParams.get("cwd") ?? "" : undefined
      const value = await manager.withLegacyPlugin(req, { pluginId: PLUGIN, projectPath: cwd, signal: controller.signal }, caller => {
        const guard = caller.options.authorize
        caller.options.authorize = async () => { if (req.aborted || res.destroyed || socket?.destroyed || controller.signal.aborted) throw new PluginDataError("CANCELED", "Request ended"); await guard() }
        return handler(manager, caller, req, url, body)
      })
      if (!req.aborted && !res.destroyed && !socket?.destroyed && !controller.signal.aborted) sendJson(res, 200, value)
    } catch (error) {
      if (!res.destroyed && !controller.signal.aborted) sendRouteError(res, error instanceof z.ZodError ? new PluginDataError("INVALID_REQUEST", "Invalid ClickUp request") : error)
    } finally { req.off("aborted", abort); res.off?.("close", abort) }
  })
  route("status", ["GET"], (manager, caller) => statusFor(manager, caller))
  route("token", ["POST", "DELETE"], async (manager, caller, req, _url, body) => {
    const value = await snapshot(manager, caller)
    if (req.method === "DELETE") await manager.disconnect(caller.request, { ...address(caller), expectedRevision: value.revision }, caller.options)
    else {
      const token = z.strictObject({ token: z.string().transform(value => value.trim()).refine(isClickUpToken) }).parse(body).token
      await manager.setCredential(caller.request, { ...address(caller), secret: token, expectedRevision: value.revision }, caller.options)
    }
    return statusFor(manager, caller)
  })
  route("tasks/mine", ["GET"], async (manager, caller) => ({ ...await identity(manager, caller), ...await pages(caller, "mine", {}) }))
  route("tasks/list", ["GET"], async (manager, caller) => {
    const who = await identity(manager, caller), selected = (await snapshot(manager, caller)).connection.selected.list
    if (!selected) throw new PluginDataError("RESOURCE_REQUIRED", "Choose a ClickUp list")
    const [list, open, recent] = await Promise.all([caller.call("list", {}).then(parseListResponse), pages(caller, "tasks", { closed: false }), pages(caller, "tasks", { closed: true, updatedAfter: Math.max(0, deps.now() - CLOSED_WINDOW_MS) }, 1)])
    if (list.id !== selected.id) throw new PluginDataError("INVALID_RESPONSE", "Invalid ClickUp list")
    const seen = new Set(open.tasks.map(task => task.id))
    return { ...who, list, tasks: [...open.tasks, ...recent.tasks.filter(task => task.status.type === "closed" && !seen.has(task.id))], truncated: open.truncated }
  }, true)
  route("spaces", ["GET"], async (manager, caller) => {
    const who = await identity(manager, caller)
    const spaces = await manager.listResourceOptions(caller.request, { ...address(caller), resourceId: "space" }, caller.options)
    return { workspace: who.workspace, spaces: spaces.map(value => ({ id: value.id, name: value.label })) }
  })
  route("lists", ["GET"], async (manager, caller, _req, url) => {
    const spaceId = z.string().regex(/^\d{1,128}$/).parse(url.searchParams.get("spaceId"))
    await ensureWorkspace(manager, caller)
    const lists = await manager.previewResourceOptions(caller.request, { ...address(caller), resourceId: "list", parents: { space: spaceId } }, caller.options)
    return { spaceId, lists: lists.map(value => ({ id: value.selection.id, name: value.selection.label, folderName: value.parent?.label ?? null })) }
  })
  route("project-list", ["GET", "PUT"], async (manager, caller, req, _url, body) => {
    let value = await snapshot(manager, caller)
    if (req.method === "PUT") {
      const parsed = z.strictObject({ cwd: z.string().min(1).max(4096), listId: z.string().regex(/^\d{1,128}$/).nullable() }).parse(body)
      const next = await manager.selectLegacyClickUpList(caller.request, { ...address(caller), listId: parsed.listId, expectedRevision: value.revision }, caller.options)
      value = { ...next, connection: next.connections.find(connection => connection.id === CONNECTION)! }
    }
    return { cwd: caller.projectPath, listId: value.connection.selected.list?.id ?? null }
  }, true)
}
