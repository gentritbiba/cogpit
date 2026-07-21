import { dirname } from "node:path"
import {
  dirs,
  isCodexDirName,
  isWithinDir,
  resolve,
  resolveSessionFilePath,
} from "../../helpers"

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
  return isCodexDirName(dirName) || isWithinDir(dirs.PROJECTS_DIR, filePath)
    ? filePath
    : null
}
