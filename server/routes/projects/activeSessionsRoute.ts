import type { IncomingMessage, ServerResponse } from "node:http"
import {
  dirs,
  encodeCodexDirName,
  getSessionMeta,
  getSessionStatus,
  join,
  listCodexSessionFiles,
  projectDirToReadableName,
  readdir,
  searchSessionMessages,
  stat,
} from "../../helpers"
import type { NextFn } from "../../helpers"

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
    const entries = await readdir(dirs.PROJECTS_DIR, { withFileTypes: true })

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

    const codexFiles = await listCodexSessionFiles()
    for (const file of codexFiles) {
      try {
        const meta = await getSessionMeta(file.filePath)
        if (!meta.cwd) continue
        candidates.push({
          dirName: encodeCodexDirName(meta.cwd),
          fileName: file.fileName,
          filePath: file.filePath,
          mtimeMs: file.mtimeMs,
          size: file.size,
        })
      } catch {
        continue
      }
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
    const now = Date.now()
    const q = search ? search.toLowerCase() : ""

    const results = await Promise.all(
      scanPool.map(async (c) => {
        try {
          const [meta, statusInfo] = await Promise.all([
            getSessionMeta(c.filePath),
            getSessionStatus(c.filePath),
          ])
          const shortName = c.dirName.startsWith("codex__")
            ? `${(meta.cwd || "").replace(/\/+$/, "").split("/").at(-1) || "Codex"} (Codex)`
            : projectDirToReadableName(c.dirName).shortName
          const lastModified = new Date(c.mtimeMs).toISOString()

          let matchedMessage: string | undefined
          if (search) {
            const metaMatch =
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

          return {
            dirName: c.dirName,
            projectShortName: shortName,
            fileName: c.fileName,
            sessionId: meta.sessionId || c.fileName.replace(".jsonl", ""),
            slug: meta.slug,
            model: meta.model,
            firstUserMessage: meta.firstUserMessage,
            lastUserMessage: meta.lastUserMessage,
            gitBranch: meta.gitBranch,
            cwd: meta.cwd,
            lastModified,
            lastActivityAt: meta.lastTimestamp || lastModified,
            turnCount: meta.turnCount,
            size: c.size,
            isActive: now - c.mtimeMs < 5 * 60 * 1000,
            agentStatus: statusInfo.status,
            agentToolName: statusInfo.toolName,
            ...(matchedMessage !== undefined && { matchedMessage }),
          }
        } catch {
          return null
        }
      })
    )

    const activeSessions = results.filter(Boolean)

    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify(activeSessions))
  } catch (err) {
    res.statusCode = 500
    res.end(JSON.stringify({ error: String(err) }))
  }
}
