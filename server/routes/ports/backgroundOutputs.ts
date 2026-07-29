import type { IncomingMessage, ServerResponse } from "node:http"
import {
  lstat,
  readdir,
  join,
  open,
  stat,
} from "../../helpers"
import { tmpdir } from "node:os"
import type { NextFn } from "../../http"

/**
 * Roots Claude Code may place per-project task output under, most likely first.
 * macOS resolves /tmp to /private/tmp; Windows has neither, so it needs %TEMP%.
 * The uid suffix only exists where getuid() does.
 */
function taskOutputBases(): string[] {
  const uid = process.getuid?.()
  const suffix = uid === undefined ? "claude" : `claude-${uid}`
  if (process.platform === "win32") return [join(tmpdir(), suffix)]
  return [...new Set([`/private/tmp/${suffix}`, `/tmp/${suffix}`, join(tmpdir(), suffix)])]
}

export interface BackgroundOutputFile {
  fileName: string
  path: string
  isSymbolicLink: boolean
}

export interface BackgroundOutputPrefix {
  content: string
  modifiedAt: number
  size: number
}

/**
 * Parse the request shape shared by the two background-output collection
 * routes. `undefined` means the middleware does not match; `null` means the
 * route matches but the required cwd query parameter is absent.
 */
function getBackgroundOutputCwd(
  req: IncomingMessage,
): string | null | undefined {
  if (req.method !== "GET") return undefined

  const url = new URL(req.url || "/", "http://localhost")
  const pathParts = url.pathname.split("/").filter(Boolean)
  if (pathParts.length > 0) return undefined

  return url.searchParams.get("cwd") || null
}

/** List Claude task output files while tolerating a missing task directory. */
async function listBackgroundOutputFiles(
  cwd: string,
): Promise<BackgroundOutputFile[]> {
  const projectHash = cwd.replace(/[\\/:@. ]/g, "-")

  let fileNames: string[] = []
  let tasksDir = ""
  for (const base of taskOutputBases()) {
    const candidate = join(base, projectHash, "tasks")
    try {
      fileNames = await readdir(candidate)
      tasksDir = candidate
      break
    } catch {
      continue
    }
  }
  if (!tasksDir) return []

  const files: BackgroundOutputFile[] = []
  for (const fileName of fileNames) {
    if (!fileName.endsWith(".output")) continue

    const path = join(tasksDir, fileName)
    try {
      const stats = await lstat(path)
      files.push({ fileName, path, isSymbolicLink: stats.isSymbolicLink() })
    } catch {
      continue
    }
  }
  return files
}

/** Execute the common HTTP and discovery lifecycle for both collections. */
export async function handleBackgroundOutputCollection<T>(
  req: IncomingMessage,
  res: ServerResponse,
  next: NextFn,
  collect: (files: BackgroundOutputFile[]) => Promise<T>,
): Promise<void> {
  const cwd = getBackgroundOutputCwd(req)
  if (cwd === undefined) return next()
  if (cwd === null) {
    res.statusCode = 400
    res.end(JSON.stringify({ error: "cwd query param required" }))
    return
  }

  try {
    const files = await listBackgroundOutputFiles(cwd)
    const result = await collect(files)
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify(result))
  } catch (err) {
    res.statusCode = 500
    res.end(JSON.stringify({ error: String(err) }))
  }
}

/** Read a bounded prefix and its metadata, or null when the file disappears. */
export async function readBackgroundOutputPrefix(
  filePath: string,
  maxBytes: number,
): Promise<BackgroundOutputPrefix | null> {
  try {
    const stats = await stat(filePath)
    let content = ""

    if (stats.size > 0) {
      const file = await open(filePath, "r")
      try {
        const buffer = Buffer.alloc(Math.min(stats.size, maxBytes))
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
        content = buffer.subarray(0, bytesRead).toString("utf-8")
      } finally {
        await file.close()
      }
    }

    return { content, modifiedAt: stats.mtimeMs, size: stats.size }
  } catch {
    return null
  }
}
