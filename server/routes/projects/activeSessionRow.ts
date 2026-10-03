import {
  matchesPullRequestTarget,
  type PullRequestSearch,
} from "../../../shared/session/sessionSearch"
import {
  getSessionMeta,
  getSessionStatus,
  join,
  readdir,
  searchSessionMessages,
  stat,
} from "../../helpers"
import { descriptorForDirName } from "../../../shared/session/agent-descriptors"
import { teamLeadFor, type TeamConfigCache } from "../../agents/lineage"
import { listedSessionId } from "../../agents/listedSession"
import { runtimeFor } from "../../agents/runtimes"
import type { TopLevelSessionInfo } from "../../agents/types"
import { getOrLoadSessionMeta } from "../../lib/sessionMetaCache"
import { getSessionPullRequests } from "../../lib/sessionPrIndex"
import type { SessionPrSearchSnapshot } from "../../lib/sessionPrSearchIndex"
import type { ArchiveReason } from "../../lib/sessionArchive"
import { projectLabel } from "./projectLabel"

/** What every row of one /api/active-sessions request is read against. */
export interface ActiveSessionQuery {
  /** The text search as typed; empty when not searching. */
  search: string
  pullRequestSearch: PullRequestSearch | null
  pullRequestIndex: SessionPrSearchSnapshot | null
  archivedById: ReadonlyMap<string, ArchiveReason>
  /** Teammate sessions carry a teamName; each team's config is read once per request. */
  teamConfigs: TeamConfigCache
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

/** One /api/active-sessions row, or null when a search rules it out or it cannot be read. */
export async function readActiveSessionRow(c: TopLevelSessionInfo, query: ActiveSessionQuery) {
  const { search, pullRequestSearch, pullRequestIndex } = query
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
      const q = search.toLowerCase()
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

    // The session the row's visibility was checked for, never an id the transcript's content opens with.
    const sessionId = listedSessionId(c)
    const teamLead = meta.teamName
      ? await teamLeadFor({ sessionId, teamName: meta.teamName, timestamp: meta.timestamp }, query.teamConfigs)
      : "none"
    const descriptor = descriptorForDirName(c.dirName)
    // The runtime's own turn state, for an agent whose transcript lags it.
    const isRuntimeActive = descriptor.capabilities.turnLiveness === "runtime"
      && runtimeFor(descriptor.kind).activity(sessionId).running
    const hasRunningAgents = statusInfo.status === "awaiting_agents"
      && await hasFreshAgentTranscripts(c.filePath)
    const archivedReason = query.archivedById.get(sessionId)

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
        teamLeadSessionId: typeof teamLead === "object" ? teamLead.sessionId : undefined,
      }),
      ...(matchedMessage !== undefined && { matchedMessage }),
    }
  } catch {
    return null
  }
}
