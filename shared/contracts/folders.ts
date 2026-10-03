/**
 * The folder browser a remote Cogpit uses to pick where a new session starts:
 * `GET /api/folders?path=<absolute>` lists one folder's subfolders on the
 * server, `POST /api/folders` makes a new one.
 */

/** Most subfolders one listing returns; `truncated` says the folder holds more. */
export const FOLDER_LISTING_LIMIT = 1000

/** Longest folder name accepted, in UTF-8 bytes: the common filesystem limit. */
const FOLDER_NAME_MAX_BYTES = 255

export interface FolderEntry {
  name: string
  path: string
}

/** `GET /api/folders`. */
export interface FolderListing {
  /** The folder listed, as an absolute path. */
  path: string
  /** The folder above it, or null at the top of what the caller may browse. */
  parent: string | null
  /** Where browsing starts: the server's projects root. */
  root: string
  /** The caller may browse and make folders only inside `root`. */
  confined: boolean
  /** Its subfolders, hidden ones left out, sorted by name ignoring case. */
  folders: FolderEntry[]
  /** The folder holds more subfolders than `folders` lists. */
  truncated: boolean
}

/** `POST /api/folders` body. */
export interface CreateFolderRequest {
  parent: string
  name: string
}

/** `POST /api/folders` answer. */
export interface CreatedFolder {
  path: string
}

function hasControlCharacter(name: string): boolean {
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** What is wrong with a new folder's name, or null when it names exactly one folder. */
export function folderNameProblem(name: string): string | null {
  if (name.trim() === "") return "Enter a folder name"
  if (name !== name.trim()) return "A folder name cannot start or end with a space"
  if (name === "." || name === "..") return `"${name}" is not a folder name`
  if (name.includes("/") || name.includes("\\")) return "A folder name cannot contain / or \\"
  if (hasControlCharacter(name)) return "A folder name cannot contain control characters"
  if (new TextEncoder().encode(name).length > FOLDER_NAME_MAX_BYTES) return "That folder name is too long"
  return null
}
