import { authFetch, jsonFetch } from "@/lib/auth"
import { readError } from "@/lib/httpJson"
import type { CreatedFolder, FolderListing } from "../../shared/contracts/folders"

// ── Folder API (server/routes/folders.ts) ────────────────────────────────
//
// Both calls go through authFetch, so on a hub they reach the active device.

/** A server from before the folder routes answers them with the API's generic 404. */
const UNSUPPORTED = "Browsing folders needs a newer Cogpit on this machine."

async function failure(res: Response): Promise<Error> {
  const message = await readError(res, `Request failed (${res.status})`)
  return new Error(res.status === 404 && message === "Not found" ? UNSUPPORTED : message)
}

/** One folder's subfolders on the server; null lists the server's projects root. */
export async function fetchFolderListing(path: string | null, signal?: AbortSignal): Promise<FolderListing> {
  const res = await authFetch(path ? `/api/folders?path=${encodeURIComponent(path)}` : "/api/folders", { signal })
  if (!res.ok) throw await failure(res)
  return await res.json() as FolderListing
}

/** Make one new folder in `parent` on the server and return its path. */
export async function createFolder(parent: string, name: string): Promise<string> {
  const res = await jsonFetch("/api/folders", { parent, name })
  if (!res.ok) throw await failure(res)
  return (await res.json() as CreatedFolder).path
}

// ── Breadcrumb ───────────────────────────────────────────────────────────

export interface PathCrumb {
  label: string
  path: string
}

/**
 * Every folder from the top of the filesystem down to `path`, the server's
 * spelling kept: POSIX paths, drive paths (`C:\Users`) and network shares
 * (`\\server\share\dir`). With `top`, from that folder down, for a caller
 * who may go no higher.
 */
export function pathCrumbs(path: string, top: string | null = null): PathCrumb[] {
  const crumbs = allCrumbs(path)
  if (top === null) return crumbs
  const trimmed = (value: string) => value.replace(/[\\/]+$/, "")
  const start = crumbs.findIndex((crumb) => trimmed(crumb.path) === trimmed(top))
  return start === -1 ? crumbs : crumbs.slice(start)
}

function allCrumbs(path: string): PathCrumb[] {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  let top: PathCrumb
  let below: string[]
  let separator: string
  if (path.startsWith("\\\\")) {
    const [server = "", share = "", ...rest] = parts
    top = { label: `\\\\${server}\\${share}`, path: `\\\\${server}\\${share}\\` }
    below = rest
    separator = "\\"
  } else if (/^[a-z]:/i.test(path)) {
    const [drive = "", ...rest] = parts
    top = { label: drive, path: `${drive}\\` }
    below = rest
    separator = "\\"
  } else {
    top = { label: "/", path: "/" }
    below = parts
    separator = "/"
  }
  return [top, ...below.map((label, index) => ({
    label,
    path: top.path + below.slice(0, index + 1).join(separator),
  }))]
}

// ── Opening the browser from anywhere ────────────────────────────────────

const FOLDER_BROWSER_EVENT = "cogpit-browse-folders"

/** Open the project switcher on the folder browser; the app shell hosts it. */
export function openFolderBrowser(): void {
  window.dispatchEvent(new Event(FOLDER_BROWSER_EVENT))
}

/** Call `listener` on each request to open the folder browser. Returns the stop. */
export function onFolderBrowserRequest(listener: () => void): () => void {
  window.addEventListener(FOLDER_BROWSER_EVENT, listener)
  return () => window.removeEventListener(FOLDER_BROWSER_EVENT, listener)
}
