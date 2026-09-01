import type { IncomingMessage, ServerResponse } from "node:http"
import { sortSessionsByRecency } from "../../../shared/session-ordering"
import {
  matchesPullRequestTarget,
  parsePullRequestSearch,
} from "../../../shared/session/sessionSearch"
import {
  dirs,
  encodeCopilotDirName,
  encodeCodexDirName,
  getSessionMeta,
  getSessionStatus,
  isWithinDir,
  join,
  projectDirToReadableName,
  readFile,
  readdir,
  searchSessionMessages,
  shortNameFromPath,
  stat,
} from "../../helpers"
import type { NextFn } from "../../http"
import { getOrLoadSessionMeta } from "../../lib/sessionMetaCache"
import { getSessionPullRequests } from "../../lib/sessionPrIndex"
import { getSessionPrSearchSnapshot } from "../../lib/sessionPrSearchIndex"
import { getCodexSessionInventory } from "../../lib/codexSessionInventory"
import { getCopilotSessionInventory } from "../../lib/copilotSessionInventory"
import { RouteError, sendError, ErrorCodes } from "../../lib/routeError"
import { readClaudeProjectEntries } from "./claudeProjectEntries"
import { codexAppServer } from "../../codex-app-server"
import { copilotRuntime } from "../../copilot-runtime"

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

interface ExternalSessionFile {
  cwd: string
  fileName: string
  filePath: string
  mtimeMs: number
  size: number
  sessionId: string
  isSubagent: boolean
}

function appendExternalCandidates(
  candidates: ActiveSessionCandidate[],
  files: ExternalSessionFile[],
  encodeDirName: (cwd: string) => string,
  projectFilter: string,
): void {
  for (const file of files) {
    if (file.isSubagent) continue
    const dirName = encodeDirName(file.cwd)
    if (projectFilter && dirName !== projectFilter) continue
    candidates.push({
      dirName,
      fileName: file.fileName,
      filePath: file.filePath,
      mtimeMs: file.mtimeMs,
      size: file.size,
      projectPath: file.cwd,
      sessionId: file.sessionId,
    })
  }
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

  try {
    const entries = await readClaudeProjectEntries()

    // First pass: collect all session files with their mtime (cheap stat only)
    const candidates: ActiveSessionCandidate[] = []

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "memory") continue
      if (projectFilter && entry.name !== projectFilter) continue
      const projectDir = join(dirs.PROJECTS_DIR, entry.name)

      let files: string[]
      try {
        files = await readdir(projectDir)
      } catch {
        continue
      }
      const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"))

      for (const f of jsonlFiles) {
        const filePath = join(projectDir, f)
        try {
          const s = await stat(filePath)
          candidates.push({
            dirName: entry.name,
            fileName: f,
            filePath,
            mtimeMs: s.mtimeMs,
            size: s.size,
          })
        } catch { /* skip */ }
      }
    }

    appendExternalCandidates(
      candidates,
      await getCodexSessionInventory(),
      encodeCodexDirName,
      projectFilter,
    )
    appendExternalCandidates(
      candidates,
      await getCopilotSessionInventory(),
      encodeCopilotDirName,
      projectFilter,
    )

    // Sort by mtime descending within each project, then pick top N per project
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)

    const pullRequestIndex = pullRequestSearch
      ? await getSessionPrSearchSnapshot(candidates)
      : null
    if (pullRequestIndex) {
      res.setHeader("X-Cogpit-PR-Index-Pending", String(pullRequestIndex.pending))
      res.setHeader("X-Cogpit-PR-Index-Total", String(pullRequestIndex.total))
    }

    let scanPool: typeof candidates
    if (pullRequestSearch && pullRequestIndex) {
      scanPool = candidates.filter((candidate) => (
        pullRequestIndex.byFile.get(candidate.filePath)?.references.some(
          (reference) => reference.number === pullRequestSearch.number,
        )
      ))
    } else if (search) {
      // When searching, scan a wider pool then filter
      scanPool = candidates.slice(0, 100)
    } else if (projectFilter) {
      // Loading more for a specific project — use totalLimit directly
      scanPool = candidates.slice(0, totalLimit)
    } else {
      // Default: pick top `perProject` from each project, then cap at totalLimit
      const byProject = new Map<string, typeof candidates>()
      for (const c of candidates) {
        const list = byProject.get(c.dirName)
        if (list) list.push(c)
        else byProject.set(c.dirName, [c])
      }

      const selected: typeof candidates = []
      for (const [, projectCandidates] of byProject) {
        selected.push(...projectCandidates.slice(0, perProject))
      }
      // Re-sort combined list by mtime and cap
      selected.sort((a, b) => b.mtimeMs - a.mtimeMs)
      scanPool = selected.slice(0, totalLimit)
    }

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
        const shortName = c.dirName.startsWith("codex__")
          ? `${meta.cwd ? shortNameFromPath(meta.cwd) : "Codex"} (Codex)`
          : c.dirName.startsWith("copilot__")
            ? `${meta.cwd ? shortNameFromPath(meta.cwd) : "Copilot"} (Copilot)`
            : projectDirToReadableName(c.dirName).shortName
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
        const isNativeCodexActive = c.dirName.startsWith("codex__")
          && codexAppServer.getActiveTurnId(sessionId) !== undefined
        const isCopilotActive = c.dirName.startsWith("copilot__")
          && copilotRuntime.isTurnActive(sessionId)
        const hasRunningAgents = statusInfo.status === "awaiting_agents"
          && await hasFreshAgentTranscripts(c.filePath)

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
          isActive: isNativeCodexActive || isCopilotActive || hasRunningAgents,
          agentStatus: statusInfo.status,
          agentToolName: statusInfo.toolName,
          agentTerminalReason: statusInfo.terminalReason,
          agentPendingAgents: statusInfo.pendingAgents,
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

    const activeSessions = sortSessionsByRecency(
      results.flatMap((session) => session ? [session] : []),
    ).slice(0, totalLimit)

    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify(activeSessions))
  } catch (err) {
    sendError(res, new RouteError(500, ErrorCodes.INTERNAL_ERROR, String(err)))
  }
}
