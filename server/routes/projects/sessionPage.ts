import type { IncomingMessage, ServerResponse } from "node:http"
import { getSessionMeta, getSessionStatus } from "../../helpers"
import { storeForDirName } from "../../agents"
import type { ProjectSessionFileInfo } from "../../agents/types"
import { allVisible, visibilityFor, type VisibilityCheck, type VisibleItem } from "../../edition"
import { sendJson } from "../../http"
import { requestScope } from "../requestScope"
import { getOrLoadSessionMeta } from "../../lib/sessionMetaCache"
import { getScannedSessionPullRequests } from "../../lib/sessionPrIndex"
import { listedSession, listedSessionId } from "../../agents/listedSession"
import { visibleLineage } from "./visibleLineage"

const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 200

/**
 * One row, the same shape as /api/active-sessions, so a row reads the same
 * whether it came from the live list or this listing — and shares that route's
 * meta cache, so a session in both costs one parse between them. The row names
 * the session its visibility was checked for, never an id the transcript's
 * content opens with.
 */
async function sessionRow(file: ProjectSessionFileInfo) {
  const lastModified = new Date(file.mtimeMs).toISOString()
  const fromFile = {
    fileName: file.fileName,
    sessionId: listedSessionId(file),
    size: file.size,
    lastModified,
  }
  try {
    const { meta, status } = await getOrLoadSessionMeta(
      file.filePath,
      file.mtimeMs,
      async () => {
        const [loaded, derived] = await Promise.all([
          getSessionMeta(file.filePath),
          getSessionStatus(file.filePath),
        ])
        return { meta: loaded, status: derived }
      },
    )
    // Read-only: this route serves one page view rather than a poll, so it
    // cannot advance a partial scan. Whatever the live list already folded in
    // comes along free.
    const pullRequests = getScannedSessionPullRequests(file.filePath, file.size)
    const { lastTimestamp, ...rest } = meta
    return {
      ...rest,
      ...fromFile,
      lastActivityAt: lastTimestamp || lastModified,
      agentStatus: status.status,
      agentToolName: status.toolName,
      agentTerminalReason: status.terminalReason,
      agentPendingAgents: status.pendingAgents,
      ...(pullRequests?.length && { pullRequests }),
    }
  } catch {
    return fromFile
  }
}

/** The project's sessions the caller may see, newest first; null when `dirName` names no project. */
async function visibleSessionFiles(
  dirName: string,
  check: VisibilityCheck,
): Promise<Array<VisibleItem<ProjectSessionFileInfo>> | null> {
  if (check.nothing) return []
  const files = await storeForDirName(dirName).listProjectSessionFiles(dirName)
  if (!files) return null
  return allVisible([...files].sort((a, b) => b.mtimeMs - a.mtimeMs), check, listedSession)
}

/**
 * GET /api/sessions/:dirName?page=&limit=&scope= — a project's sessions the
 * caller may see in the scope, newest first. Visibility is decided before
 * paging, so every page is full and `total` counts only the caller's sessions.
 */
export async function handleSessionPage(
  req: IncomingMessage,
  res: ServerResponse,
  dirName: string,
  params: URLSearchParams,
): Promise<void> {
  const check = visibilityFor(req, requestScope(req))
  try {
    const page = Math.max(1, parseInt(params.get("page") || "1", 10))
    const limit = Math.min(Math.max(1, parseInt(params.get("limit") || String(DEFAULT_PAGE_SIZE), 10)), MAX_PAGE_SIZE)

    const visible = await visibleSessionFiles(dirName, check)
    if (!visible) {
      sendJson(res, 403, { error: "Access denied" })
      return
    }

    const start = (page - 1) * limit
    const lineage = visibleLineage(check)
    const rows = await Promise.all(visible.slice(start, start + limit).map(
      async ({ item, session }) => session.annotate(await lineage(await sessionRow(item))),
    ))
    const sessions = rows.filter((row) => row !== null)

    sendJson(res, 200, { sessions, total: visible.length, page, pageSize: limit })
  } catch (err) {
    sendJson(res, 500, { error: String(err) })
  }
}
