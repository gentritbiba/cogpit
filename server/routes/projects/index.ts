import type { UseFn } from "../../helpers"
import {
  dirs,
  CODEX_SESSIONS_DIR,
  decodeCodexDirName,
  encodeCodexDirName,
  findJsonlPath,
  getSessionMeta,
  isCodexDirName,
  isWithinDir,
  join,
  listCodexSessionFiles,
  open,
  projectDirToReadableName,
  readFile,
  readdir,
  resolveSessionFilePath,
  stat,
} from "../../helpers"
import { handleActiveSessions } from "./activeSessionsRoute"
import { readClaudeProjectEntries } from "./claudeProjectEntries"

// ── Bottom-first loading helpers ────────────────────────────────────────────

const HEADER_BYTES = 4096

interface TailResult {
  lines: string[]
  byteOffset: number
  totalSize: number
}

interface RangeResult {
  lines: string[]
  byteOffset: number
  hasMore: boolean
}

interface HeaderResult {
  lines: string[]
  bytesRead: number
}

/**
 * Reads the last `byteCount` bytes of a file and returns complete JSONL lines.
 * When reading from the middle of the file, the first partial line is discarded.
 */
async function readTail(filePath: string, byteCount: number): Promise<TailResult> {
  const fh = await open(filePath, "r")
  try {
    const fileStat = await fh.stat()
    const totalSize = fileStat.size

    const readStart = Math.max(0, totalSize - byteCount)
    const readLength = totalSize - readStart
    const buf = Buffer.allocUnsafe(readLength)
    const { bytesRead } = await fh.read(buf, 0, readLength, readStart)
    const text = buf.subarray(0, bytesRead).toString("utf-8")

    let lines = text.split("\n").filter((l) => l.trim().length > 0)

    // Discard potentially partial first line when reading from the middle
    // and compute the correct byte offset of the first complete line.
    let adjustedOffset = readStart
    if (readStart > 0 && lines.length > 0) {
      lines = lines.slice(1)
      const firstNewline = text.indexOf("\n")
      if (firstNewline >= 0) {
        adjustedOffset = readStart + firstNewline + 1
      }
    }

    return { lines, byteOffset: adjustedOffset, totalSize }
  } finally {
    await fh.close()
  }
}

/**
 * Reads JSONL lines between `startOffset` and `endOffset` (exclusive).
 * Returns the lines plus whether there is more content before `startOffset`.
 */
async function readRange(filePath: string, startOffset: number, endOffset: number): Promise<RangeResult> {
  const fh = await open(filePath, "r")
  try {
    const fileStat = await fh.stat()
    const totalSize = fileStat.size

    const readStart = Math.max(0, startOffset)
    const readEnd = Math.min(endOffset, totalSize)
    const readLength = readEnd - readStart
    if (readLength <= 0) {
      return { lines: [], byteOffset: readStart, hasMore: readStart > 0 }
    }

    const buf = Buffer.allocUnsafe(readLength)
    const { bytesRead } = await fh.read(buf, 0, readLength, readStart)
    const text = buf.subarray(0, bytesRead).toString("utf-8")

    let lines = text.split("\n").filter((l) => l.trim().length > 0)

    // Discard potentially partial first line when reading from the middle
    if (readStart > 0 && lines.length > 0) {
      lines = lines.slice(1)
    }

    return { lines, byteOffset: readStart, hasMore: readStart > 0 }
  } finally {
    await fh.close()
  }
}

/**
 * Reads the first `HEADER_BYTES` bytes of a file for metadata extraction.
 */
async function readSessionHeader(filePath: string): Promise<HeaderResult> {
  const fh = await open(filePath, "r")
  try {
    const fileStat = await fh.stat()
    const readLen = Math.min(HEADER_BYTES, fileStat.size)
    const buf = Buffer.allocUnsafe(readLen)
    const { bytesRead } = await fh.read(buf, 0, readLen, 0)
    const text = buf.subarray(0, bytesRead).toString("utf-8")
    const parts = text.split("\n").filter((l) => l.trim().length > 0)
    // Drop the last element if we didn't read the whole file — it's likely truncated
    if (bytesRead < fileStat.size && parts.length > 0) {
      parts.pop()
    }
    return { lines: parts, bytesRead }
  } finally {
    await fh.close()
  }
}

function shortNameFromPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "")
  return trimmed.split("/").at(-1) || trimmed || path
}

export function registerProjectRoutes(use: UseFn) {
  // GET /api/projects - list all projects
  use("/api/projects", async (_req, res, next) => {
    if (_req.method !== "GET") return next()
    if (_req.url && _req.url !== "/" && _req.url !== "") return next()

    try {
      const entries = await readClaudeProjectEntries()
      const projects = []

      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name === "memory") continue

        const projectDir = join(dirs.PROJECTS_DIR, entry.name)
        const files = await readdir(projectDir)
        const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"))

        if (jsonlFiles.length === 0) continue

        let latestTime = 0
        let latestFile: string | null = null
        for (const f of jsonlFiles) {
          try {
            const s = await stat(join(projectDir, f))
            if (s.mtimeMs > latestTime) {
              latestTime = s.mtimeMs
              latestFile = f
            }
          } catch { /* ignore stat errors */ }
        }

        const { path: realPath, shortName } = projectDirToReadableName(entry.name)

        // dirName-derived path is unreliable for dirs with hyphens; prefer cwd from session meta
        let cwd: string | null = null
        if (latestFile) {
          try {
            const meta = await getSessionMeta(join(projectDir, latestFile))
            cwd = meta.cwd ?? null
          } catch { /* ignore, fall back to derived path */ }
        }

        projects.push({
          dirName: entry.name,
          path: cwd ?? realPath,
          shortName,
          sessionCount: jsonlFiles.length,
          lastModified: latestTime ? new Date(latestTime).toISOString() : null,
        })
      }

      const codexFiles = await listCodexSessionFiles()
      const codexProjects = new Map<string, { latestTime: number; sessionCount: number }>()
      for (const file of codexFiles) {
        try {
          const meta = await getSessionMeta(file.filePath)
          if (!meta.cwd) continue
          // Skip Codex sub-agent sessions — they're shown inline in their parent
          if (meta.isSubagent) continue
          const existing = codexProjects.get(meta.cwd)
          if (existing) {
            existing.latestTime = Math.max(existing.latestTime, file.mtimeMs)
            existing.sessionCount += 1
          } else {
            codexProjects.set(meta.cwd, { latestTime: file.mtimeMs, sessionCount: 1 })
          }
        } catch {
          continue
        }
      }

      for (const [cwd, info] of codexProjects) {
        projects.push({
          dirName: encodeCodexDirName(cwd),
          path: cwd,
          shortName: `${shortNameFromPath(cwd)} (Codex)`,
          sessionCount: info.sessionCount,
          lastModified: info.latestTime ? new Date(info.latestTime).toISOString() : null,
        })
      }

      projects.sort((a, b) => {
        if (!a.lastModified) return 1
        if (!b.lastModified) return -1
        return b.lastModified.localeCompare(a.lastModified)
      })

      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify(projects))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: String(err) }))
    }
  })

  // GET /api/sessions/:dirName - list sessions / serve file content
  use("/api/sessions/", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const parts = url.pathname.split("/").filter(Boolean)

    if (parts.length === 1) {
      const dirName = decodeURIComponent(parts[0])
      const codexCwd = decodeCodexDirName(dirName)
      const projectDir = join(dirs.PROJECTS_DIR, dirName)

      if (!codexCwd && !isWithinDir(dirs.PROJECTS_DIR, projectDir)) {
        res.statusCode = 403
        res.end(JSON.stringify({ error: "Access denied" }))
        return
      }

      try {
        const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10))
        const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10)), 200)

        type FileStat = { fileName: string; filePath: string; mtime: Date; size: number }

        const fileStats: FileStat[] = codexCwd
          ? (await Promise.all(
            (await listCodexSessionFiles())
              .map(async (file) => {
                try {
                  const meta = await getSessionMeta(file.filePath)
                  if (meta.cwd !== codexCwd) return null
                  if (meta.isSubagent) return null
                  return {
                    fileName: file.fileName,
                    filePath: file.filePath,
                    mtime: new Date(file.mtimeMs),
                    size: file.size,
                  }
                } catch {
                  return null
                }
              })
          )).filter((file): file is FileStat => file !== null)
          : await Promise.all(
            (await readdir(projectDir))
              .filter((f) => f.endsWith(".jsonl"))
              .map(async (f) => {
                const filePath = join(projectDir, f)
                try {
                  const fileStat = await stat(filePath)
                  return { fileName: f, filePath, mtime: fileStat.mtime, size: fileStat.size }
                } catch {
                  return { fileName: f, filePath, mtime: new Date(0), size: 0 }
                }
              })
          )

        fileStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

        const total = fileStats.length
        const start = (page - 1) * limit
        const paged = fileStats.slice(start, start + limit)

        const sessions = []
        for (const fs of paged) {
          try {
            const meta = await getSessionMeta(fs.filePath)
            sessions.push({
              ...meta,
              fileName: fs.fileName,
              sessionId: meta.sessionId || fs.fileName.replace(".jsonl", ""),
              size: fs.size,
              lastModified: fs.mtime.toISOString(),
            })
          } catch {
            sessions.push({
              fileName: fs.fileName,
              sessionId: fs.fileName.replace(".jsonl", ""),
              size: fs.size,
              lastModified: fs.mtime.toISOString(),
            })
          }
        }

        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ sessions, total, page, pageSize: limit }))
      } catch (err) {
        res.statusCode = 500
        res.end(JSON.stringify({ error: String(err) }))
      }
    } else if (parts.length === 3 && parts[2] === "subagents") {
      // GET /api/sessions/{dirName}/{sessionId}/subagents — list subagent files
      const dirName = decodeURIComponent(parts[0])
      if (isCodexDirName(dirName)) {
        // For Codex sessions, find sub-agent files by checking forked_from_id
        const parentSessionId = decodeURIComponent(parts[1])
        try {
          const codexFiles = await listCodexSessionFiles()
          const listing: Array<{ agentId: string; fileName: string; size: number; modifiedAt: number }> = []
          for (const file of codexFiles) {
            try {
              const meta = await getSessionMeta(file.filePath)
              if (!meta.isSubagent || meta.parentSessionId !== parentSessionId) continue
              listing.push({
                agentId: meta.sessionId,
                fileName: file.fileName,
                size: file.size,
                modifiedAt: file.mtimeMs,
              })
            } catch { continue }
          }
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify(listing))
        } catch {
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify([]))
        }
        return
      }
      const sessionId = decodeURIComponent(parts[1])
      const subagentsDir = join(dirs.PROJECTS_DIR, dirName, sessionId, "subagents")
      if (!isWithinDir(dirs.PROJECTS_DIR, subagentsDir)) {
        res.statusCode = 403
        res.end(JSON.stringify({ error: "Access denied" }))
        return
      }
      try {
        const files = await readdir(subagentsDir)
        const listing: Array<{ agentId: string; size: number; modifiedAt: number }> = []
        for (const f of files) {
          if (!f.startsWith("agent-") || !f.endsWith(".jsonl")) continue
          const agentId = f.replace("agent-", "").replace(".jsonl", "")
          try {
            const s = await stat(join(subagentsDir, f))
            listing.push({ agentId, size: s.size, modifiedAt: s.mtimeMs })
          } catch { continue }
        }
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify(listing))
      } catch {
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify([]))
      }
    } else if (parts.length >= 2) {
      // Serve session file content (supports nested paths like sessionId/subagents/file.jsonl)
      const dirName = decodeURIComponent(parts[0])
      const fileParts = parts.slice(1).map(decodeURIComponent)
      const fileName = fileParts.join("/")

      if (!fileName.endsWith(".jsonl")) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: "Only .jsonl files" }))
        return
      }

      let filePath = await resolveSessionFilePath(dirName, fileName)

      // For Codex sessions, resolve virtual paths by session ID lookup.
      // Matches sub-agent paths ({parentId}/subagents/agent-{id}.jsonl)
      // and simple session ID paths ({sessionId}.jsonl).
      if (!filePath && isCodexDirName(dirName)) {
        const idMatch = fileName.match(/\/subagents\/agent-([^.]+)\.jsonl$/)
          ?? fileName.match(/^([^/]+)\.jsonl$/)
        if (idMatch) {
          const resolved = await findJsonlPath(idMatch[1])
          if (resolved && resolved.startsWith(CODEX_SESSIONS_DIR + "/")) {
            filePath = resolved
          }
        }
      }

      if (!filePath) {
        res.statusCode = 403
        res.end(JSON.stringify({ error: "Access denied" }))
        return
      }

      const tailParam = url.searchParams.get("tail")
      const beforeParam = url.searchParams.get("before")
      const countParam = url.searchParams.get("count")

      try {
        if (tailParam !== null) {
          // ?tail=N — return last N turns worth of lines plus header lines
          const requestedTurns = Math.max(1, Math.min(parseInt(tailParam) || 30, 200))
          const bytesToRead = requestedTurns * 65536

          const [header, tail] = await Promise.all([
            readSessionHeader(filePath),
            readTail(filePath, bytesToRead),
          ])

          const hasMore = tail.byteOffset > header.bytesRead

          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({
            headerLines: header.lines,
            tailLines: tail.lines,
            byteOffset: tail.byteOffset,
            totalSize: tail.totalSize,
            hasMore,
          }))
        } else if (beforeParam !== null) {
          // ?before=offset&count=N — return lines before the given byte offset
          const endOffset = Math.max(0, parseInt(beforeParam) || 0)
          const requestedTurns = Math.max(1, Math.min(parseInt(countParam || "") || 30, 200))
          const bytesToRead = requestedTurns * 65536
          const startOffset = Math.max(0, endOffset - bytesToRead)

          const [header, range] = await Promise.all([
            readSessionHeader(filePath),
            readRange(filePath, startOffset, endOffset),
          ])

          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({
            headerLines: header.lines,
            lines: range.lines,
            byteOffset: range.byteOffset,
            hasMore: range.byteOffset > header.bytesRead,
          }))
        } else {
          // Default: return full file as text/plain (original behavior)
          const content = await readFile(filePath, "utf-8")
          res.setHeader("Content-Type", "text/plain")
          res.end(content)
        }
      } catch {
        res.statusCode = 404
        res.end(JSON.stringify({ error: "File not found" }))
      }
    } else {
      next()
    }
  })

  // GET /api/active-sessions - list most recent sessions across all projects
  use("/api/active-sessions", handleActiveSessions)

  // GET /api/find-session/:sessionId - find a session JSONL file by its session ID
  use("/api/find-session/", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const parts = url.pathname.split("/").filter(Boolean)
    if (parts.length !== 1) return next()

    const sessionId = decodeURIComponent(parts[0])
    try {
      const filePath = await findJsonlPath(sessionId)
      if (filePath) {
        const isCodex = filePath.startsWith(CODEX_SESSIONS_DIR + "/")
        if (isCodex) {
          const meta = await getSessionMeta(filePath)
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({
            dirName: encodeCodexDirName(meta.cwd || ""),
            fileName: filePath.slice(CODEX_SESSIONS_DIR.length + 1),
          }))
          return
        }

        const fileName = filePath.split("/").at(-1) || `${sessionId}.jsonl`
        const dirName = filePath.slice(0, -fileName.length - 1).split("/").at(-1) || ""
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ dirName, fileName }))
        return
      }
      res.statusCode = 404
      res.end(JSON.stringify({ error: "Session not found" }))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: String(err) }))
    }
  })
}
