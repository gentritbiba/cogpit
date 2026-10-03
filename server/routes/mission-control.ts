/**
 * GET /api/mission-control — card payloads for the Mission Control grid.
 *
 * Pending permission requests are deliberately not here: GET /api/permissions
 * serves those, because the sidebar and header need them whether or not this
 * view is open.
 */

import type { IncomingMessage, ServerResponse } from "node:http"
import { sendJson, type NextFn, type UseFn } from "../http"
import { allTopLevelSessions } from "../agents"
import { listedSession, listedSessionId } from "../agents/listedSession"
import { takeVisible, visibilityFor, visibleInOrder } from "../edition"
import { requestScope } from "./requestScope"
import { summarizeSession } from "../lib/missionControlSummary"
import type { MissionControlResponse } from "../../shared/contracts/missionControl"

const DEFAULT_LIMIT = 24
const MAX_LIMIT = 60

export async function handleMissionControl(
  req: IncomingMessage,
  res: ServerResponse,
  next: NextFn,
): Promise<void> {
  if (req.method !== "GET") return next()

  const check = visibilityFor(req, requestScope(req))
  const url = new URL(req.url || "/", "http://localhost")
  const requested = Number.parseInt(url.searchParams.get("limit") ?? "", 10)
  const limit = Number.isFinite(requested)
    ? Math.max(1, Math.min(requested, MAX_LIMIT))
    : DEFAULT_LIMIT

  try {
    // An agent whose history cannot be read contributes nothing; the others still show.
    const recent = check.nothing
      ? []
      : await takeVisible(visibleInOrder(await allTopLevelSessions({ skipUnreadable: true }), check, listedSession), limit)
    const settled = await Promise.all(recent.map(async ({ item, session }) => {
      const summary = await summarizeSession(listedSessionId(item), item.filePath).catch(() => null)
      return summary && session.annotate(summary)
    }))
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
