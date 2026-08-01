/**
 * GET /api/mission-control — card payloads for the Mission Control grid.
 *
 * Returns a rich summary for the most recently active sessions plus every
 * pending permission request across all sessions, so the grid can render a
 * blocked session's Allow/Deny inline without opening it.
 */

import type { IncomingMessage, ServerResponse } from "node:http"
import { sendJson, type NextFn, type UseFn } from "../http"
import { dirs, join, readdir, stat } from "../helpers"
import { getCodexSessionInventory } from "../lib/codexSessionInventory"
import { readClaudeProjectEntries } from "./projects/claudeProjectEntries"
import { summarizeSession } from "../lib/missionControlSummary"
import { collectPendingPermissions, listPermissionSessionIds } from "./permissions"
import { getToolSummary } from "../../shared/session/toolSummary"
import type {
  MissionControlPermission,
  MissionControlResponse,
  MissionControlSummary,
} from "../../shared/contracts/missionControl"

const DEFAULT_LIMIT = 24
const MAX_LIMIT = 60

interface Candidate {
  sessionId: string
  filePath: string
  mtimeMs: number
}

/** Most recently modified session files across Claude projects and Codex. */
async function collectRecentSessionFiles(limit: number): Promise<Candidate[]> {
  const candidates: Candidate[] = []

  for (const entry of await readClaudeProjectEntries()) {
    if (!entry.isDirectory() || entry.name === "memory") continue
    const projectDir = join(dirs.PROJECTS_DIR, entry.name)
    let files: string[]
    try {
      files = await readdir(projectDir)
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue
      const filePath = join(projectDir, file)
      try {
        const info = await stat(filePath)
        candidates.push({
          sessionId: file.replace(/\.jsonl$/, ""),
          filePath,
          mtimeMs: info.mtimeMs,
        })
      } catch {
        /* skip unreadable files */
      }
    }
  }

  try {
    for (const file of await getCodexSessionInventory()) {
      if (file.isSubagent) continue
      candidates.push({
        sessionId: file.sessionId,
        filePath: file.filePath,
        mtimeMs: file.mtimeMs,
      })
    }
  } catch {
    /* Codex inventory is optional */
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return candidates.slice(0, limit)
}

/** Flatten pending requests across sessions into card-ready rows. */
function collectPermissions(): MissionControlPermission[] {
  const rows: MissionControlPermission[] = []
  for (const sessionId of listPermissionSessionIds()) {
    for (const request of collectPendingPermissions(sessionId)) {
      const input =
        request.input && typeof request.input === "object"
          ? (request.input as Record<string, unknown>)
          : {}
      // Only Codex advertises the decisions it accepts; other providers take all.
      const available = (request as { availableDecisions?: MissionControlPermission["availableDecisions"] })
        .availableDecisions
      rows.push({
        sessionId,
        requestId: request.requestId,
        toolName: request.toolName,
        summary: getToolSummary({ name: request.toolName, input }),
        title: request.title,
        description: request.description,
        ...(available && { availableDecisions: available }),
        timestamp: request.timestamp,
      })
    }
  }
  return rows
}

export async function handleMissionControl(
  req: IncomingMessage,
  res: ServerResponse,
  next: NextFn,
): Promise<void> {
  if (req.method !== "GET") return next()

  const url = new URL((req.url || "/").replace(/^\/?/, "/"), "http://localhost")
  const requested = Number.parseInt(url.searchParams.get("limit") ?? "", 10)
  const limit = Number.isFinite(requested)
    ? Math.max(1, Math.min(requested, MAX_LIMIT))
    : DEFAULT_LIMIT

  try {
    const candidates = await collectRecentSessionFiles(limit)
    const settled = await Promise.all(
      candidates.map((c) => summarizeSession(c.sessionId, c.filePath).catch(() => null)),
    )
    const summaries = settled.filter((s): s is MissionControlSummary => s !== null)

    const body: MissionControlResponse = {
      summaries,
      permissions: collectPermissions(),
      generatedAt: new Date().toISOString(),
    }
    sendJson(res, 200, body)
  } catch (err) {
    sendJson(res, 500, { error: String(err) })
  }
}

export function registerMissionControlRoutes(use: UseFn) {
  use("/api/mission-control", handleMissionControl)
}
