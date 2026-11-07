import {
  matchesPullRequestTarget,
  type PullRequestSearch,
} from "../../../shared/session/sessionSearch"
import { searchSessionMessages } from "../../helpers"
import { descriptorForDirName } from "../../../shared/session/agent-descriptors"
import { teamLeadFor, type TeamConfigCache } from "../../agents/lineage"
import { listedSessionId } from "../../agents/listedSession"
import { sessionAgentsRunning } from "../../agents/agentsRunning"
import { runtimeFor } from "../../agents/runtimes"
import type { TopLevelSessionInfo } from "../../agents/types"
import { catalogRow } from "../../sessionCatalog"
import { peekSessionPullRequests, type SessionPrSearchSnapshot } from "../../lib/sessionPrSearchIndex"
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

const TITLE_LENGTH = 80

/** What a session is called where its row is not listed: its own title, else its first prompt. */
export async function readSessionTitle(c: TopLevelSessionInfo): Promise<string | undefined> {
  try {
    const { meta } = await catalogRow(c)
    const title = meta.customTitle || meta.aiTitle || meta.firstUserMessage || meta.slug
    const line = title?.split("\n").map((part) => part.trim()).find(Boolean)
    return line ? line.slice(0, TITLE_LENGTH) : undefined
  } catch {
    return undefined
  }
}

/** One /api/active-sessions row, or null when a search rules it out or it cannot be read. */
export async function readActiveSessionRow(c: TopLevelSessionInfo, query: ActiveSessionQuery) {
  const { search, pullRequestSearch, pullRequestIndex } = query
  try {
    const indexedPullRequestData = pullRequestIndex?.byFile.get(c.filePath)
    const [cached, pullRequests] = await Promise.all([
      catalogRow(c),
      indexedPullRequestData
        ? Promise.resolve(indexedPullRequestData.pullRequests)
        : peekSessionPullRequests(c).then((data) => data?.pullRequests ?? []),
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
    // Checked outside the mtime-keyed meta cache: the parent transcript stays
    // untouched while its agents work, which is exactly what it cannot see.
    const hasRunningAgents = statusInfo.status === "awaiting_agents"
      && await sessionAgentsRunning(c.dirName, sessionId)
    const archivedReason = query.archivedById.get(sessionId)

    return {
      dirName: c.dirName,
      projectShortName: shortName,
      fileName: c.fileName,
      sessionId,
      slug: meta.slug,
      name: meta.name,
      aiTitle: meta.aiTitle,
      ...(meta.customTitle && { customTitle: meta.customTitle }),
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
