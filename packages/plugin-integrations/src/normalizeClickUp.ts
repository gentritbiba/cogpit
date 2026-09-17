import type { ClickUpErrorCode, ClickUpListOption, ClickUpListSummary, ClickUpPriority, ClickUpSpace, ClickUpStatus, ClickUpStatusType, ClickUpTag, ClickUpTask, ClickUpUser, ClickUpWorkspace } from "./clickup.js"

function record(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null }
function text(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback }
const NUMERIC_ID = /^\d+$/
const STATUS_TYPES = new Set<ClickUpStatusType>(["open", "custom", "closed", "done"])
const PRIORITIES = new Set<ClickUpPriority>(["urgent", "high", "normal", "low"])
export class ClickUpDataError extends Error {
  constructor(readonly status: number, readonly code: ClickUpErrorCode, message: string) { super(message) }
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

function invalid(what: string): ClickUpDataError {
  return new ClickUpDataError(502, "invalid_response", `ClickUp returned an invalid ${what} response`)
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

