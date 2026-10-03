import type { IncomingMessage, ServerResponse } from "node:http"
import { open, stat } from "../../helpers"
import { listProjectTaskOutputs, type ListedTaskOutput } from "../../agents/taskOutput"
import { allVisible, visibilityFor, type VisibilityCheck } from "../../edition"
import type { NextFn } from "../../http"

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

/** The outputs filed under a session `check` shows, each session checked once. */
async function visibleOutputs(check: VisibilityCheck, files: ListedTaskOutput[]): Promise<ListedTaskOutput[]> {
  if (check.everything) return files
  const sessions = [...new Set(files.map((file) => file.sessionId))]
  const visible = new Set((await allVisible(sessions, check, (sessionId) => ({ sessionId }))).map(({ item }) => item))
  return files.filter((file) => visible.has(file.sessionId))
}

/**
 * Execute the common HTTP and discovery lifecycle for both collections.
 * `collect` sees only output filed under a session the caller may see, and
 * gets the check for whatever else a row names.
 */
export async function handleBackgroundOutputCollection<T>(
  req: IncomingMessage,
  res: ServerResponse,
  next: NextFn,
  collect: (files: ListedTaskOutput[], check: VisibilityCheck) => Promise<T>,
): Promise<void> {
  const cwd = getBackgroundOutputCwd(req)
  if (cwd === undefined) return next()
  if (cwd === null) {
    res.statusCode = 400
    res.end(JSON.stringify({ error: "cwd query param required" }))
    return
  }

  try {
    const check = visibilityFor(req)
    const files = check.nothing ? [] : await visibleOutputs(check, await listProjectTaskOutputs(cwd))
    const result = await collect(files, check)
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
