/**
 * Stored views: small React apps an agent keeps as files on the computer that
 * runs its session. That computer builds each version into one finished page;
 * a reply names the version with a ```cogpit-view block holding `<id>@<n>`.
 */

/** Lowercase words joined by single hyphens, at most 48 characters. */
const VIEW_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_ID_LENGTH = 48

export function isViewId(value: string): boolean {
  return value.length <= MAX_ID_LENGTH && VIEW_ID.test(value)
}

export interface ViewReference {
  id: string
  version: number
}

const MAX_VERSION = 1_000_000

/** The `<id>@<n>` a reply carries for a stored view, or null for an inline view's markup. */
export function parseViewReference(body: string): ViewReference | null {
  const match = /^([a-z0-9-]+)@([1-9][0-9]{0,6})$/.exec(body.trim())
  if (!match || !isViewId(match[1]!)) return null
  const version = Number(match[2])
  return version <= MAX_VERSION ? { id: match[1]!, version } : null
}

export function formatViewReference({ id, version }: ViewReference): string {
  return `${id}@${version}`
}

/** One file of a view's source, by its path inside the view's `app/` folder. */
export interface ViewSourceFile {
  path: string
  text: string
}

/** What `GET /api/views/<id>/v/<n>` returns. */
export interface StoredViewVersion {
  id: string
  title: string
  version: number
  latestVersion: number
  /** The finished page, waiting for the viewer's theme (`withViewTheme`). */
  html: string
  files: ViewSourceFile[]
}

export function viewVersionPath({ id, version }: ViewReference): string {
  return `/api/views/${id}/v/${version}`
}

/** A stored view as the sidebar lists it: `GET /api/views` returns `{ views: ViewSummary[] }`, newest first. */
export interface ViewSummary {
  id: string
  title: string
  /** The project folder the view was made in, worktrees folded into their parent checkout. */
  project: string
  /** The session that made it, when known. */
  sessionId?: string
  /** Null until the first build. */
  latestVersion: number | null
  updatedAt: string
  pinned: boolean
}

/** `PATCH /api/views/<id>` body; answers the updated `ViewSummary`. `DELETE /api/views/<id>` removes the view and its versions. */
export interface ViewUpdate {
  title?: string
  pinned?: boolean
}

export const VIEWS_PATH = "/api/views"
