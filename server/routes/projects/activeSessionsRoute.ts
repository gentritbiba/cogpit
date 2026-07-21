import type { IncomingMessage, ServerResponse } from "node:http"
import { sortSessionsByRecency } from "../../../shared/session-ordering"
import {
  dirs,
  encodeCodexDirName,
  getSessionMeta,
  getSessionStatus,
  isWithinDir,
  join,
  projectDirToReadableName,
  readFile,
  readdir,
  searchSessionMessages,
  stat,
} from "../../helpers"
import type { NextFn } from "../../http"
import { getOrLoadSessionMeta } from "../../lib/sessionMetaCache"
import { getCodexSessionInventory } from "../../lib/codexSessionInventory"
import { RouteError, sendError, ErrorCodes } from "../../lib/routeError"
import { readClaudeProjectEntries } from "./claudeProjectEntries"
import { codexAppServer } from "../../codex-app-server"

const DEFAULT_PER_PROJECT = 10
const DEFAULT_TOTAL = 50

export async function handleActiveSessions(
  req: IncomingMessage,
  res: ServerResponse,
  next: NextFn,
): Promise<void> {
  if (req.method !== "GET") return next()
  if (req.url && !req.url.startsWith("?") && !req.url.startsWith("/?") && req.url !== "/" && req.url !== "") return next()

  const url = new URL((req.url || "/").replace(/^\/?/, "/"), "http://localhost")
  const search = url.searchParams.get("search")?.trim() || ""
  const perProject = Math.min(parseInt(url.searchParams.get("perProject") || String(DEFAULT_PER_PROJECT), 10), 100)
  const totalLimit = Math.min(parseInt(url.searchParams.get("limit") || String(search ? 50 : DEFAULT_TOTAL), 10), 200)
  // Optional: load sessions for a specific project only (used by "show more")
  const projectFilter = url.searchParams.get("project")?.trim() || ""

  try {
    const entries = await readClaudeProjectEntries()

    // First pass: collect all session files with their mtime (cheap stat only)
    const candidates: Array<{
      dirName: string
      fileName: string
      filePath: string
      mtimeMs: number
      size: number
    }> = []

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

    const codexFiles = await getCodexSessionInventory()
    for (const file of codexFiles) {
      // Codex sub-agents are shown inline in their parent.
      if (file.isSubagent) continue
      candidates.push({
        dirName: encodeCodexDirName(file.cwd),
        fileName: file.fileName,
        filePath: file.filePath,
        mtimeMs: file.mtimeMs,
        size: file.size,
      })
    }

    // Sort by mtime descending within each project, then pick top N per project
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)

    let scanPool: typeof candidates
    if (search) {
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

    const results = await Promise.all(
      scanPool.map(async (c) => {
        try {
          const cached = await getOrLoadSessionMeta(c.filePath, c.mtimeMs, async () => {
            const [meta, status] = await Promise.all([
                getSessionMeta(c.filePath),
                getSessionStatus(c.filePath),
            ])
            return { meta, status }
          })
          const { meta, status: statusInfo } = cached
          const shortName = c.dirName.startsWith("codex__")
            ? `${(meta.cwd || "").replace(/\/+$/, "").split("/").at(-1) || "Codex"} (Codex)`
            : projectDirToReadableName(c.dirName).shortName
          const lastModified = new Date(c.mtimeMs).toISOString()

          let matchedMessage: string | undefined
          if (search) {
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
          const sessionId = meta.sessionId || c.fileName.replace(".jsonl", "")
          const isNativeCodexActive = c.dirName.startsWith("codex__")
            && codexAppServer.getActiveTurnId(sessionId) !== undefined

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
            isActive: isNativeCodexActive,
            agentStatus: statusInfo.status,
            agentToolName: statusInfo.toolName,
            agentTerminalReason: statusInfo.terminalReason,
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
      })
    )

    const activeSessions = sortSessionsByRecency(results.flatMap((session) => session ? [session] : []))

    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify(activeSessions))
  } catch (err) {
    sendError(res, new RouteError(500, ErrorCodes.INTERNAL_ERROR, String(err)))
  }
}
