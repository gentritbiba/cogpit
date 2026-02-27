import type { IncomingMessage, ServerResponse } from "node:http"
import { dirs, projectDirToReadableName, getSessionMeta, searchSessionMessages, readdir, stat, join } from "../../helpers"
import type { NextFn } from "../../helpers"

export async function handleActiveSessions(
  req: IncomingMessage,
  res: ServerResponse,
  next: NextFn,
): Promise<void> {
  if (req.method !== "GET") return next()
  if (req.url && !req.url.startsWith("?") && !req.url.startsWith("/?") && req.url !== "/" && req.url !== "") return next()

  const url = new URL((req.url || "/").replace(/^\/?/, "/"), "http://localhost")
  const search = url.searchParams.get("search")?.trim() || ""
  const defaultLimit = search ? 50 : 30
  const limit = Math.min(parseInt(url.searchParams.get("limit") || String(defaultLimit), 10), 100)

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
        } catch {
          // skip inaccessible files
        }
      }
    }

    // Sort by mtime descending; when searching, scan top 50 then filter
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const scanPool = search ? candidates.slice(0, 50) : candidates.slice(0, limit)

    // Second pass: read metadata (+ search) in parallel for speed
    const now = Date.now()
    const q = search ? search.toLowerCase() : ""

    const results = await Promise.all(
      scanPool.map(async (c) => {
        try {
          const meta = await getSessionMeta(c.filePath)
          const { shortName } = projectDirToReadableName(c.dirName)
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
            turnCount: meta.turnCount,
            size: c.size,
            isActive: now - c.mtimeMs < 5 * 60 * 1000,
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
