/**
 * The Library: what agents shared in their replies, kept per session on the
 * computer that ran it. `GET /api/library` lists one tab of it for a scope.
 */

/** What an item is. A view item names a stored view a reply showed. */
export type LibraryItemKind = "image" | "video" | "link" | "file" | "view"

/** The tabs the server lists; Media holds images and videos. Views are listed by `/api/views`. */
export type LibraryTab = "media" | "link" | "file"

export const LIBRARY_TABS: readonly LibraryTab[] = ["media", "link", "file"]

export type LibraryScope = "session" | "project" | "all"

export const LIBRARY_SCOPES: readonly LibraryScope[] = ["session", "project", "all"]

/**
 * Whether the library holds its own copy of a local file:
 * `kept` it does; `missing` the file was gone when it looked; `changed` the
 * file was rewritten after it was shared, so its content is not what the
 * reply showed; `too-large` over the size limit; `evicted` dropped, or never
 * made, to keep newer copies under the quota; `failed` the copy could not be
 * made. Null until it looks, and always for links and views.
 */
export type LibraryKeepState = "kept" | "missing" | "changed" | "too-large" | "evicted" | "failed"

export interface LibraryItem {
  /** The newest occurrence; `DELETE /api/library/items/<id>` removes it and its duplicates. */
  id: number
  kind: LibraryItemKind
  /** A link's URL, a file's absolute path, or a view's id. */
  target: string
  /** Link text or alt text, when it says more than the target. */
  label: string | null
  sessionId: string
  /** The reply's turn, to open the session at it. */
  turnId: string | null
  turn: number
  sharedAt: string | null
  /** The project folder, worktrees folded into their parent checkout. */
  project: string
  /** The library's own copy of a local file, on the computer that ran the session. */
  keptPath: string | null
  keepState: LibraryKeepState | null
  /** A local file is still at its original path; always true for links and views. */
  present: boolean
  /** Occurrences folded into this item: the same link or file shared again. */
  mentions: number
}

export interface LibrarySession {
  title: string | null
  cwd: string
}

/** Items per tab in the scope. The Views tab counts the views it lists itself. */
export interface LibraryCounts {
  media: number
  link: number
  file: number
}

export interface LibraryResponse {
  /** False when the session index cannot run here, so nothing is collected. */
  available: boolean
  /** Transcripts the session index has yet to read; items may still arrive. */
  pendingFiles: number
  counts: LibraryCounts
  /** The tab's items, newest first; none when the request named no tab. */
  items: LibraryItem[]
  /** Stored views the scope's replies showed, which the Views tab lists besides those its sessions made. */
  viewIds: string[]
  /** Pass as `before` for the next page; null on the last. */
  next: string | null
  /** The sessions the items came from. */
  sessions: Record<string, LibrarySession>
}

export const LIBRARY_PATH = "/api/library"

/** Items per page when a request names no `limit`. */
export const LIBRARY_PAGE = 60
/** The largest `limit` a request may name. */
export const LIBRARY_MAX_PAGE = 200

export function libraryTabOf(kind: LibraryItemKind): LibraryTab | null {
  if (kind === "view") return null
  return kind === "image" || kind === "video" ? "media" : kind
}
