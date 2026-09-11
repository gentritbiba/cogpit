import type { IncomingMessage, ServerResponse } from "node:http"
import { sortSessionsByRecency } from "../../../shared/session-ordering"
import {
  matchesPullRequestTarget,
  parsePullRequestSearch,
} from "../../../shared/session/sessionSearch"
import {
  dirs,
  getSessionMeta,
  getSessionStatus,
  isWithinDir,
  join,
  readFile,
  readdir,
  searchSessionMessages,
  stat,
} from "../../helpers"
import { descriptorForDirName } from "../../../shared/session/agent-descriptors"
import { allStores } from "../../agents"
import { runtimeFor } from "../../agents/runtimes"
import { sendJson, type NextFn } from "../../http"
import { getOrLoadSessionMeta } from "../../lib/sessionMetaCache"
import { getSessionPullRequests } from "../../lib/sessionPrIndex"
import { getSessionPrSearchSnapshot } from "../../lib/sessionPrSearchIndex"
import { archiveReason, readArchive, setSessionsArchived, type ArchiveReason } from "../../lib/sessionArchive"
import { RouteError, sendError, ErrorCodes } from "../../lib/routeError"
import { projectLabel } from "./projectLabel"

const DEFAULT_PER_PROJECT = 10
const DEFAULT_TOTAL = 50

interface ActiveSessionCandidate {
  dirName: string
  fileName: string
  filePath: string
  mtimeMs: number
  size: number
  projectPath?: string
  sessionId?: string
}

/** The archive key for a candidate, before its metadata has been read. */
function candidateId(c: ActiveSessionCandidate): string {
  return c.sessionId || c.fileName.replace(/\.jsonl$/, "")
}

/**
 * Whether a session's background agents are demonstrably still writing their
 * own transcripts. The parent JSONL goes silent while background agents and
 * workflows run, so mtime-recency on the parent alone would triage the
 * session as finished. Checked only for sessions whose derived status is
 * awaiting_agents, and outside the mtime-keyed meta cache — freshness is
 * exactly what the cache cannot answer.
 */
async function hasFreshAgentTranscripts(sessionFilePath: string, now = Date.now()): Promise<boolean> {
  const FRESH_MS = 60_000
  const sessionDir = sessionFilePath.replace(/\.jsonl$/, "")
  const queue = [{ dir: sessionDir, depth: 0 }]
  let statBudget = 200

  while (queue.length > 0 && statBudget > 0) {
    const { dir, depth } = queue.shift()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (statBudget-- <= 0) break
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < 2) queue.push({ dir: fullPath, depth: depth + 1 })
        continue
      }
      if (!entry.name.endsWith(".jsonl")) continue
      try {
        const s = await stat(fullPath)
        if (now - s.mtimeMs < FRESH_MS) return true
      } catch { /* skip */ }
    }
  }
  return false
}

export async function handleActiveSessions(
  req: IncomingMessage,
  res: ServerResponse,
  next: NextFn,
): Promise<void> {
  if (req.method !== "GET") return next()
  if (req.url && !req.url.startsWith("?") && !req.url.startsWith("/?") && req.url !== "/" && req.url !== "") return next()

  const url = new URL((req.url || "/").replace(/^\/?/, "/"), "http://localhost")
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
    // First pass: collect all session files with their mtime (cheap stat only)
    let candidates: ActiveSessionCandidate[] = []

    for (const store of allStores()) {
      for (const session of await store.listTopLevelSessions()) {
        if (projectFilter && session.dirName !== projectFilter) continue
        candidates.push({
          dirName: session.dirName,
          fileName: session.fileName,
          filePath: session.filePath,
          mtimeMs: session.mtimeMs,
          size: session.size,
          projectPath: session.projectPath,
          sessionId: session.sessionId,
        })
      }
    }

    const archive = await readArchive()
    const now = Date.now()
    const resumedSessionIds: string[] = []
    const archivedById = new Map<string, ArchiveReason>()
    for (const c of candidates) {
      const id = candidateId(c)
      const reason = archiveReason(archive, id, c.mtimeMs, now)
      if (reason) archivedById.set(id, reason)
      else if (archive.archived.has(id)) resumedSessionIds.push(id)
    }
    // A transcript written after archiving means the session was resumed —
    // it comes back on its own, so the stale entry is dropped.
    if (resumedSessionIds.length > 0) {
      setSessionsArchived(resumedSessionIds, false).catch(() => {})
    }
    res.setHeader("X-Cogpit-Archived-Count", String(archivedById.size))
    const isArchived = (c: ActiveSessionCandidate) => archivedById.has(candidateId(c))
    // Archived rows are picked separately from the live list so they never
    // take a listed session's place under the per-project cap.
    const archivedCandidates = includeArchived ? candidates.filter(isArchived) : []
    candidates = candidates.filter((c) => !isArchived(c))

    // Sort by mtime descending within each project, then pick top N per project
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
    archivedCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs)

    const pullRequestIndex = pullRequestSearch
      ? await getSessionPrSearchSnapshot([...candidates, ...archivedCandidates])
      : null
    if (pullRequestIndex) {
      res.setHeader("X-Cogpit-PR-Index-Pending", String(pullRequestIndex.pending))
      res.setHeader("X-Cogpit-PR-Index-Total", String(pullRequestIndex.total))
    }

    const selectPool = (pool: ActiveSessionCandidate[]): ActiveSessionCandidate[] => {
      if (pullRequestSearch && pullRequestIndex) {
        return pool.filter((candidate) => (
          pullRequestIndex.byFile.get(candidate.filePath)?.references.some(
            (reference) => reference.number === pullRequestSearch.number,
          )
        ))
      }
      // When searching, scan a wider pool then filter
      if (search) return pool.slice(0, 100)
      // Loading more for a specific project — use totalLimit directly
      if (projectFilter) return pool.slice(0, totalLimit)
      // Default: pick top `perProject` from each project, then cap at totalLimit
      const byProject = new Map<string, ActiveSessionCandidate[]>()
      for (const c of pool) {
        const list = byProject.get(c.dirName)
        if (list) list.push(c)
        else byProject.set(c.dirName, [c])
      }
      const selected: ActiveSessionCandidate[] = []
      for (const [, projectCandidates] of byProject) {
        selected.push(...projectCandidates.slice(0, perProject))
      }
      // Re-sort combined list by mtime and cap
      selected.sort((a, b) => b.mtimeMs - a.mtimeMs)
      return selected.slice(0, totalLimit)
    }
    const scanPool = [...selectPool(candidates), ...selectPool(archivedCandidates)]

    // Second pass: read metadata (+ search) in parallel for speed
    const q = search ? search.toLowerCase() : ""

    // Teammate sessions (agent teams) carry a teamName — resolve each team's
    // lead session once per request so the client can group them together.
    const teamLeadCache = new Map<string, Promise<string | null>>()
    const resolveTeamLead = (teamName: string): Promise<string | null> => {
      let cached = teamLeadCache.get(teamName)
      if (!cached) {
        const configPath = join(dirs.TEAMS_DIR, teamName, "config.json")
        cached = isWithinDir(dirs.TEAMS_DIR, configPath)
          ? readFile(configPath, "utf-8")
              .then((raw) => {
                const lead = JSON.parse(String(raw)).leadSessionId
                return typeof lead === "string" && lead ? lead : null
              })
              .catch(() => null)
          : Promise.resolve(null)
        teamLeadCache.set(teamName, cached)
      }
      return cached
    }

    const loadCandidate = async (c: (typeof scanPool)[number]) => {
      try {
        const indexedPullRequestData = pullRequestIndex?.byFile.get(c.filePath)
        const [cached, pullRequests] = await Promise.all([
          getOrLoadSessionMeta(c.filePath, c.mtimeMs, async () => {
            const [meta, status] = await Promise.all([
              getSessionMeta(c.filePath),
              getSessionStatus(c.filePath),
            ])
            return { meta, status }
          }),
          indexedPullRequestData
            ? Promise.resolve(indexedPullRequestData.pullRequests)
            : getSessionPullRequests(c.filePath, c.size),
        ])
        const references = indexedPullRequestData?.references ?? pullRequests
        const { meta, status: statusInfo } = cached
        const shortName = projectLabel(c.dirName, meta.cwd)
        const lastModified = new Date(c.mtimeMs).toISOString()

        let matchedMessage: string | undefined
        let matchedPullRequestNumber: number | undefined
        if (pullRequestSearch) {
          const repositoryContext = [meta.cwd, c.projectPath, shortName, c.dirName]
          const matchedReference = references.find((reference) => (
            matchesPullRequestTarget(reference, pullRequestSearch, repositoryContext)
          ))
          if (!matchedReference) return null
          matchedPullRequestNumber = matchedReference.number
        } else if (search) {
          const metaMatch =
            meta.aiTitle?.toLowerCase().includes(q) ||
            meta.firstUserMessage?.toLowerCase().includes(q) ||
            meta.lastUserMessage?.toLowerCase().includes(q) ||
            meta.slug?.toLowerCase().includes(q) ||
            meta.gitBranch?.toLowerCase().includes(q) ||
            meta.cwd?.toLowerCase().includes(q)

          if (metaMatch) {
            matchedMessage = meta.lastUserMessage || meta.firstUserMessage || meta.slug || ""
          } else {
            const found = await searchSessionMessages(c.filePath, search)
            if (!found) return null
            matchedMessage = found
          }
        }

        const teamLeadSessionId = meta.teamName
          ? await resolveTeamLead(meta.teamName)
          : null
        const sessionId = c.sessionId || meta.sessionId || c.fileName.replace(".jsonl", "")
        const descriptor = descriptorForDirName(c.dirName)
        // The runtime's own turn state, for an agent whose transcript lags it.
        const isRuntimeActive = descriptor.capabilities.turnLiveness === "runtime"
          && runtimeFor(descriptor.kind).activity(sessionId).running
        const hasRunningAgents = statusInfo.status === "awaiting_agents"
          && await hasFreshAgentTranscripts(c.filePath)
        const archivedReason = archivedById.get(sessionId)

        return {
          dirName: c.dirName,
          projectShortName: shortName,
          fileName: c.fileName,
          sessionId,
          slug: meta.slug,
          name: meta.name,
          aiTitle: meta.aiTitle,
          model: meta.model,
          firstUserMessage: meta.firstUserMessage,
          lastUserMessage: meta.lastUserMessage,
          gitBranch: meta.gitBranch,
          cwd: meta.cwd,
          lastModified,
          lastActivityAt: meta.lastTimestamp || lastModified,
          turnCount: meta.turnCount,
          size: c.size,
          isActive: isRuntimeActive || hasRunningAgents,
          agentStatus: statusInfo.status,
          agentToolName: statusInfo.toolName,
          agentTerminalReason: statusInfo.terminalReason,
          agentPendingAgents: statusInfo.pendingAgents,
          ...(archivedReason && { archived: true, archivedReason }),
          ...(pullRequests.length > 0 && { pullRequests }),
          ...(matchedPullRequestNumber && { matchedPullRequestNumber }),
          ...(meta.teamName && {
            teamName: meta.teamName,
            agentName: meta.agentName || undefined,
            teamLeadSessionId: teamLeadSessionId || undefined,
          }),
          ...(matchedMessage !== undefined && { matchedMessage }),
        }
      } catch {
        return null
      }
    }

    const results = await Promise.all(scanPool.map(loadCandidate))

    const loaded = results.flatMap((session) => session ? [session] : [])
    const activeSessions = [
      ...sortSessionsByRecency(loaded.filter((session) => !session.archived)).slice(0, totalLimit),
      ...sortSessionsByRecency(loaded.filter((session) => session.archived)).slice(0, totalLimit),
    ]

    sendJson(res, 200, activeSessions)
  } catch (err) {
    sendError(res, new RouteError(500, ErrorCodes.INTERNAL_ERROR, String(err)))
  }
}
