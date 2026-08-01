/**
 * GET /api/mission-control — card payloads for the Mission Control grid.
 *
 * Returns a rich summary for the most recently active sessions. Pending
 * permission requests come from GET /api/permissions instead, because the
 * sidebar and header need them whether or not this view is open.
 */

import type { IncomingMessage, ServerResponse } from "node:http"
import { sendJson, type NextFn, type UseFn } from "../http"
import { dirs, join, readdir, stat } from "../helpers"
import { getCodexSessionInventory } from "../lib/codexSessionInventory"
import { readClaudeProjectEntries } from "./projects/claudeProjectEntries"
import { summarizeSession } from "../lib/missionControlSummary"
import type {
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
