import { dirname } from "node:path"
import {
  dirs,
  isWithinDir,
  resolve,
} from "../../helpers"
import { storeForPath } from "../../agents"
import { resolveSessionFilePath } from "../../sessionPaths"

function isOpaqueFileName(value: string): boolean {
  return value.length > 0
    && !value.includes("/")
    && !value.includes("\\")
    && !value.includes("\0")
}

export function resolveUndoStatePath(sessionId: string): string | null {
  if (!isOpaqueFileName(sessionId)) return null

  const undoRoot = resolve(dirs.UNDO_DIR)
  const filePath = resolve(undoRoot, `${sessionId}.json`)
  return isWithinDir(undoRoot, filePath) && dirname(filePath) === undoRoot
    ? filePath
    : null
}

export function resolveEncodedUndoStatePath(encodedSessionId: string): string | null {
  try {
    return resolveUndoStatePath(decodeURIComponent(encodedSessionId))
  } catch {
    return null
  }
}

export async function resolveUndoSessionPath(
  dirName: string,
  fileName: string,
): Promise<string | null> {
  if (typeof dirName !== "string" || typeof fileName !== "string") return null
  const filePath = await resolveSessionFilePath(dirName, fileName)
  if (!filePath) return null
  // Undo may only touch a transcript some agent actually owns. Asking the store
  // registry covers every agent by construction, where the two-arm check this
  // replaced silently excluded whichever agent was added last.
  return storeForPath(filePath) ? filePath : null
}
