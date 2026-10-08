import type { IncomingMessage, ServerResponse } from "node:http"
import { compareSessionsByRecency } from "../../../shared/session-ordering"
import { parsePullRequestSearch } from "../../../shared/session/sessionSearch"
import { allTopLevelSessions } from "../../agents"
import type { TopLevelSessionInfo } from "../../agents/types"
import { allVisible, parseScope, takeVisible, visibilityFor, visibleInOrder, type VisibleItem } from "../../edition"
import { sendJson, type NextFn } from "../../http"
import { getSessionPrSearchSnapshot } from "../../lib/sessionPrSearchIndex"
import { archiveReason, readArchive, setSessionsArchived, type ArchiveReason } from "../../lib/sessionArchive"
import { RouteError, sendError, ErrorCodes } from "../../lib/routeError"
import { readActiveSessionRow, type ActiveSessionQuery } from "./activeSessionRow"
import { listedSession, listedSessionId } from "../../agents/listedSession"
import { visibleLineage } from "./visibleLineage"
import { crewSummary, planCrews } from "./crewRows"

const DEFAULT_PER_PROJECT = 10
const DEFAULT_TOTAL = 50
/** When searching, a wider pool is read and then filtered by the search. */
const SEARCH_POOL = 100

type VisibleCandidate = VisibleItem<TopLevelSessionInfo>

/** Which visible candidates, walked newest first, make the pool whose rows are read. */
interface PoolRule {
  limit: number
  perProject?: number
  matches?: (candidate: TopLevelSessionInfo) => boolean
}

/** Keeps candidates in the order given until the rule's limit, never reading past it. */
function selectPool(
  pool: AsyncIterable<VisibleCandidate> | Iterable<VisibleCandidate>,
  rule: PoolRule,
): Promise<VisibleCandidate[]> {
  const { matches, perProject } = rule
  // An unparseable per-project cap (NaN) selects nothing, as a slice to it would.
  if (perProject !== undefined && !(perProject > 0)) return Promise.resolve([])
  const taken = new Map<string, number>()
  return takeVisible(pool, rule.limit, (candidate) => {
    if (matches && !matches(candidate)) return false
    if (perProject === undefined) return true
    const count = taken.get(candidate.dirName) ?? 0
    if (count >= perProject) return false
    taken.set(candidate.dirName, count + 1)
    return true
  })
}

interface RecencyRow {
  sessionId: string
  dirName: string
  fileName: string
  lastActivityAt?: string
  lastModified?: string
  crewSummary?: { activityAt: string }
}

/** Newest first, a session listed with its crew by the crew's latest activity. */
function sortByCrewRecency<T extends RecencyRow>(rows: readonly T[]): T[] {
  const placed = (row: T) => (row.crewSummary ? { ...row, lastActivityAt: row.crewSummary.activityAt } : row)
  return [...rows].sort((a, b) => compareSessionsByRecency(placed(a), placed(b)))
}

/**
 * GET /api/active-sessions — the sessions the caller may see in `scope`,
 * newest first. Visibility is decided in recency order before any limit, so
 * the list stops checking once it is full; searches read only the transcripts
 * of visible sessions, and the archived count is the caller's own.
 *
 * A session another session started through Cogpit rides with its crew's
 * root: the root takes one place under the caps, ordered by the crew's latest
 * activity, and its members follow the listed sessions. A search lists every
 * match on its own, each carrying where it sits in its crew.
 */
export async function handleActiveSessions(
  req: IncomingMessage,
  res: ServerResponse,
  next: NextFn,
): Promise<void> {
  if (req.method !== "GET") return next()
  if (req.url && !req.url.startsWith("?") && !req.url.startsWith("/?") && req.url !== "/" && req.url !== "") return next()

  const url = new URL((req.url || "/").replace(/^\/?/, "/"), "http://localhost")
  const scope = parseScope(req, url.searchParams.get("scope"))
  const check = visibilityFor(req, scope)
  if (check.nothing) {
    res.setHeader("X-Cogpit-Archived-Count", "0")
    sendJson(res, 200, [])
    return
  }
  const search = url.searchParams.get("search")?.trim() || ""
  const pullRequestSearch = parsePullRequestSearch(search)
  const perProject = Math.min(parseInt(url.searchParams.get("perProject") || String(DEFAULT_PER_PROJECT), 10), 100)
  const totalLimit = Math.min(parseInt(url.searchParams.get("limit") || String(search ? 50 : DEFAULT_TOTAL), 10), 200)
  // Optional: load sessions for a specific project only (used by "show more")
  const projectFilter = url.searchParams.get("project")?.trim() || ""
  // Archived sessions stay out of the default list so they never crowd the
  // per-project cap; a search always looks through them.
  const includeArchived = Boolean(search) || url.searchParams.get("archived") === "include"

  try {
    // First pass: every session file with its mtime (cheap stat only), newest first.
    // Crews are placed across every project, so a root brings members that live elsewhere.
    const everySession = await allTopLevelSessions()
    const inProject = (session: TopLevelSessionInfo) => !projectFilter || session.dirName === projectFilter
    const candidates = everySession.filter(inProject)

    const archive = await readArchive()
    const now = Date.now()
    const resumedSessionIds: string[] = []
    const archivedById = new Map<string, ArchiveReason>()
    for (const c of everySession) {
      const id = listedSessionId(c)
      const reason = archiveReason(archive, id, c.mtimeMs, now)
      if (reason) archivedById.set(id, reason)
      else if (archive.archived.has(id)) resumedSessionIds.push(id)
    }
    // A transcript written after archiving means the session was resumed —
    // it comes back on its own, so the stale entry is dropped.
    if (resumedSessionIds.length > 0) {
      setSessionsArchived(resumedSessionIds, false).catch(() => {})
    }
    const isArchived = (c: TopLevelSessionInfo) => archivedById.has(listedSessionId(c))
    const plan = await planCrews(everySession, {
      grouped: !search,
      canHost: (sessionId) => !archivedById.has(sessionId),
      listsMember: (sessionId) => includeArchived || !archivedById.has(sessionId),
      check,
    })
    const units = plan.units.filter(inProject)
    const unitIds = new Set(units.map(listedSessionId))
    // Archived rows are picked separately from the live list so they never
    // take a listed session's place under the per-project cap.
    const live = units.filter((c) => !isArchived(c))
    const archived = await allVisible(candidates.filter(isArchived), check, listedSession)
    res.setHeader("X-Cogpit-Archived-Count", String(new Set(archived.map(({ item }) => listedSessionId(item))).size))
    const archivedPool = includeArchived ? archived.filter(({ item }) => unitIds.has(listedSessionId(item))) : []

    // A pull-request search filters on the index, which covers every visible candidate.
    const visibleLive = pullRequestSearch ? await allVisible(live, check, listedSession) : null
    const pullRequestIndex = visibleLive
      ? await getSessionPrSearchSnapshot([...visibleLive, ...archivedPool].map(({ item }) => item))
      : null
    if (pullRequestIndex) {
      res.setHeader("X-Cogpit-PR-Index-Pending", String(pullRequestIndex.pending))
      res.setHeader("X-Cogpit-PR-Index-Total", String(pullRequestIndex.total))
    }

    const rule: PoolRule = pullRequestSearch && pullRequestIndex
      ? {
          limit: Infinity,
          matches: (candidate) => pullRequestIndex.byFile.get(candidate.filePath)?.references.some(
            (reference) => reference.number === pullRequestSearch.number,
          ) === true,
        }
      : search ? { limit: SEARCH_POOL }
      // Loading more for a specific project — use totalLimit directly
      : projectFilter ? { limit: totalLimit }
      : { limit: totalLimit, perProject }
    const scanPool = [
      ...await selectPool(visibleLive ?? visibleInOrder(live, check, listedSession), rule),
      ...await selectPool(archivedPool, rule),
    ]

    // Second pass: read metadata (+ search) in parallel for speed
    const query: ActiveSessionQuery = {
      search,
      pullRequestSearch,
      pullRequestIndex,
      archivedById,
      teamConfigs: new Map(),
    }
    // A row may name a session the caller can open outside the scope listed.
    const lineage = visibleLineage(scope === "all" ? check : visibilityFor(req))
    const readRow = async (item: TopLevelSessionInfo, session: VisibleItem<TopLevelSessionInfo>["session"], onItsOwn: boolean) => {
      const row = await readActiveSessionRow(item, query)
      if (!row) return null
      const crew = await plan.membership(row.sessionId, onItsOwn)
      return session.annotate(await lineage(crew ? { ...row, crew } : row))
    }
    const results = await Promise.all(scanPool.map(({ item, session }) => readRow(item, session, true)))
    const loaded = results.flatMap((row) => row ? [row] : [])

    // Every member a listed session carries comes along, whatever the caps.
    const membersOf = new Map(await Promise.all(loaded.map(async (unit) => {
      const riding = (plan.membersOf.get(unit.sessionId) ?? [])
        .filter((member) => includeArchived || !isArchived(member))
      const visible = riding.length > 0 ? await allVisible(riding, check, listedSession) : []
      const rows = await Promise.all(visible.map(({ item, session }) => readRow(item, session, false)))
      return [unit.sessionId, rows.flatMap((row) => row ? [row] : [])] as const
    })))
    const withCrews = loaded.map((unit) => {
      const summary = crewSummary(unit, membersOf.get(unit.sessionId) ?? [])
      return summary ? { ...unit, crewSummary: summary } : unit
    })

    const listed = [
      ...sortByCrewRecency(withCrews.filter((row) => !row.archived)).slice(0, totalLimit),
      ...sortByCrewRecency(withCrews.filter((row) => row.archived)).slice(0, totalLimit),
    ]
    const activeSessions = [...listed, ...listed.flatMap((unit) => membersOf.get(unit.sessionId) ?? [])]

    sendJson(res, 200, activeSessions)
  } catch (err) {
    sendError(res, new RouteError(500, ErrorCodes.INTERNAL_ERROR, String(err)))
  }
}
