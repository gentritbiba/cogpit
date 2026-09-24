import type { Dirent } from "node:fs"
import { mkdir, readdir, realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import {
  FOLDER_LISTING_LIMIT,
  folderNameProblem,
  type FolderEntry,
  type FolderListing,
} from "../../shared/contracts/folders"
import { getProjectsRoot } from "../config"
import { isWithinDir } from "../pathSafety"
import { ErrorCodes, RouteError } from "./routeError"

/**
 * The server's folders, as the folder browser and session starts see them.
 * Whoever may act host-wide chooses any path; any other caller browses only
 * inside the projects root.
 */

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

/** The refusal for a filesystem error on `path`, or null for one no caller can act on. */
function refusalFor(error: unknown, path: string, action: string): RouteError | null {
  switch (errorCode(error)) {
    // ENOTDIR: a file stands where one of its ancestors should be.
    case "ENOENT":
    case "ENOTDIR":
      return new RouteError(404, ErrorCodes.NOT_FOUND, `The folder ${path} does not exist`)
    case "EACCES":
    case "EPERM":
      return new RouteError(403, ErrorCodes.FORBIDDEN, `Cogpit is not allowed to ${action} ${path}`)
    default:
      return null
  }
}

function notAFolder(path: string): RouteError {
  return new RouteError(400, ErrorCodes.INVALID_REQUEST, `${path} is not a folder`)
}

/** Refuse `path` unless it is a folder that exists. */
async function requireFolder(path: string, action: string): Promise<void> {
  let isFolder: boolean
  try {
    isFolder = (await stat(path)).isDirectory()
  } catch (error) {
    throw refusalFor(error, path, action) ?? error
  }
  if (!isFolder) throw notAFolder(path)
}

/** A caller-supplied absolute path, normalized. */
export function absoluteFolderPath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.includes("\0") || !isAbsolute(value)) {
    throw new RouteError(400, ErrorCodes.INVALID_REQUEST, `${field} must be an absolute path`)
  }
  return resolve(value)
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true })

/** By name ignoring case, with a stable order between names that differ only in case. */
function byName(a: Dirent, b: Dirent): number {
  return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

/** A directory, or a link that leads to one. */
async function isFolderEntry(parent: string, entry: Dirent): Promise<boolean> {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false
  return stat(join(parent, entry.name)).then((info) => info.isDirectory(), () => false)
}

async function anyFolder(parent: string, entries: readonly Dirent[]): Promise<boolean> {
  for (const entry of entries) {
    if (await isFolderEntry(parent, entry)) return true
  }
  return false
}

/**
 * Refuse `path` unless it lies inside `top`, links followed, so a link inside
 * the projects root cannot lead a confined caller out of it. True when `path`
 * is `top` itself.
 */
async function requireInside(top: string, path: string): Promise<boolean> {
  const [realTop, realPath] = await Promise.all([realpath(top), realpath(path)]).catch((error: unknown) => {
    throw refusalFor(error, path, "open") ?? error
  })
  if (!isWithinDir(realTop, realPath)) {
    throw new RouteError(403, ErrorCodes.FORBIDDEN, `Only folders inside ${top} are open to you`)
  }
  return realPath === realTop
}

/**
 * One folder's visible subfolders, up to FOLDER_LISTING_LIMIT of them. With
 * `top`, the caller may go no higher than it.
 */
export async function listFolder(requested: string, top: string | null = null): Promise<FolderListing> {
  const path = resolve(requested)
  const atTop = top !== null && await requireInside(top, path)
  await requireFolder(path, "open")
  let entries: Dirent[]
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch (error) {
    throw refusalFor(error, path, "open") ?? error
  }

  const candidates = entries
    .filter((entry) => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink()))
    .sort(byName)
  const folders: FolderEntry[] = []
  let next = 0
  while (next < candidates.length && folders.length < FOLDER_LISTING_LIMIT) {
    const entry = candidates[next++]
    if (await isFolderEntry(path, entry)) folders.push({ name: entry.name, path: join(path, entry.name) })
  }

  const parent = dirname(path)
  return {
    path,
    parent: parent === path || atTop ? null : parent,
    root: getProjectsRoot(),
    confined: top !== null,
    folders,
    truncated: await anyFolder(path, candidates.slice(next)),
  }
}

/**
 * Make one new folder in `parent`, never its missing ancestors, and return its
 * path. With `top`, only inside it.
 */
export async function createFolder(parent: string, name: string, top: string | null = null): Promise<string> {
  const problem = folderNameProblem(name)
  if (problem) throw new RouteError(400, ErrorCodes.INVALID_REQUEST, problem)
  const folder = resolve(parent)
  await requireFolder(folder, "create folders in")
  if (top !== null) await requireInside(top, folder)
  const path = join(folder, name)
  try {
    await mkdir(path)
  } catch (error) {
    switch (errorCode(error)) {
      case "EEXIST":
        throw new RouteError(409, ErrorCodes.CONFLICT, `${name} already exists in ${folder}`)
      case "EROFS":
        throw new RouteError(403, ErrorCodes.FORBIDDEN, `${folder} is on a read-only disk`)
      case "EINVAL":
      case "ENAMETOOLONG":
        throw new RouteError(400, ErrorCodes.INVALID_REQUEST, `${name} is not a folder name this disk accepts`)
      default:
        throw refusalFor(error, folder, "create folders in") ?? error
    }
  }
  return path
}

/**
 * Why no agent can start in `cwd`, or null when it is a folder that exists.
 * Every agent CLI fails to spawn in a missing directory with an error that
 * names the CLI instead, so a start or resume asks here first.
 */
export async function sessionFolderProblem(cwd: string): Promise<string | null> {
  try {
    await requireFolder(cwd, "open")
    return null
  } catch (error) {
    return error instanceof RouteError
      ? error.message
      : `Cogpit cannot open ${cwd}: ${error instanceof Error ? error.message : String(error)}`
  }
}
