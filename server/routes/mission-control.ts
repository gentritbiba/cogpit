/**
 * GET /api/mission-control — card payloads for the Mission Control grid.
 *
 * Pending permission requests are deliberately not here: GET /api/permissions
 * serves those, because the sidebar and header need them whether or not this
 * view is open.
 */

import type { IncomingMessage, ServerResponse } from "node:http"
import { sendJson, type NextFn, type UseFn } from "../http"
import { storeFor } from "../agents"
import { getSessionInventory } from "../lib/sessionInventory"
import { summarizeSession } from "../lib/missionControlSummary"
import type { MissionControlResponse } from "../../shared/contracts/missionControl"

const DEFAULT_LIMIT = 24
const MAX_LIMIT = 60

interface Candidate {
  sessionId: string
  filePath: string
  mtimeMs: number
}

/** Most recently modified session files across every agent. */
async function collectRecentSessionFiles(limit: number): Promise<Candidate[]> {
  const candidates: Candidate[] = []

  // Claude names its transcripts after the session, so the listing alone is
  // enough; the other agents need the identity read the inventory pays for.
  for (const file of await storeFor("claude").listSessionFiles()) {
    candidates.push({
      sessionId: file.fileName.replace(/\.jsonl$/, ""),
      filePath: file.filePath,
      mtimeMs: file.mtimeMs,
    })
  }

  for (const kind of ["codex", "copilot"] as const) {
    try {
      for (const file of await getSessionInventory(kind)) {
        if (file.isSubagent) continue
        candidates.push({
          sessionId: file.sessionId,
          filePath: file.filePath,
          mtimeMs: file.mtimeMs,
        })
      }
    } catch {
      /* An agent with no local history simply contributes nothing. */
    }
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

  const url = new URL(req.url || "/", "http://localhost")
  const requested = Number.parseInt(url.searchParams.get("limit") ?? "", 10)
  const limit = Number.isFinite(requested)
    ? Math.max(1, Math.min(requested, MAX_LIMIT))
    : DEFAULT_LIMIT

  try {
    const candidates = await collectRecentSessionFiles(limit)
    const settled = await Promise.all(
      candidates.map((c) => summarizeSession(c.sessionId, c.filePath).catch(() => null)),
    )
    const body: MissionControlResponse = {
      summaries: settled.filter((summary) => summary !== null),
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
