import {
  dirs,
  isWithinDir,
  readFile,
  writeFile,
  mkdir,
  unlink,
  join,
  resolve,
  homedir,
} from "../helpers"
import { appendFile } from "node:fs/promises"
import type { UseFn } from "../helpers"

// Directories that undo/apply must NEVER write to
const FORBIDDEN_PREFIXES = ["/etc/", "/usr/", "/bin/", "/sbin/", "/boot/", "/proc/", "/sys/", "/dev/", "/var/"]

export function registerUndoRoutes(use: UseFn) {
  // GET /api/undo-state/:sessionId - read undo state
  // POST /api/undo-state/:sessionId - save undo state
  use("/api/undo-state/", async (req, res, next) => {
    if (req.method !== "GET" && req.method !== "POST") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const parts = url.pathname.split("/").filter(Boolean)
    if (parts.length !== 1) return next()

    const sessionId = decodeURIComponent(parts[0])
    const filePath = join(dirs.UNDO_DIR, `${sessionId}.json`)

    if (req.method === "GET") {
      try {
        const content = await readFile(filePath, "utf-8")
        res.setHeader("Content-Type", "application/json")
        res.end(content)
      } catch {
        // Return 200 with null to avoid browser console noise from 404s
        res.setHeader("Content-Type", "application/json")
        res.end("null")
      }
      return
    }

    // POST - save undo state
    let body = ""
    req.on("data", (chunk: string) => { body += chunk })
    req.on("end", async () => {
      try {
        await mkdir(dirs.UNDO_DIR, { recursive: true })
        await writeFile(filePath, body, "utf-8")
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ success: true }))
      } catch (err) {
        res.statusCode = 500
        res.end(JSON.stringify({ error: String(err) }))
      }
    })
  })

  // POST /api/undo/apply - apply a batch of file operations (undo or redo)
  use("/api/undo/apply", (req, res, next) => {
    if (req.method !== "POST") return next()

    let body = ""
    req.on("data", (chunk: string) => { body += chunk })
    req.on("end", async () => {
      try {
        const { operations } = JSON.parse(body) as {
          operations: Array<{
            type: "reverse-edit" | "delete-write" | "apply-edit" | "create-write"
            filePath: string
            oldString?: string
            newString?: string
            replaceAll?: boolean
            content?: string
          }>
        }

        if (!Array.isArray(operations) || operations.length === 0) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: "operations array required" }))
          return
        }

        // Validate all file paths are absolute, don't contain traversal,
        // and are within user's home directory (not system files)
        const home = homedir()
        for (const op of operations) {
          const resolved = resolve(op.filePath)
          if (resolved !== op.filePath) {
            res.statusCode = 403
            res.end(JSON.stringify({ error: `Invalid file path: ${op.filePath}` }))
            return
          }
          // Must be within user's home directory
          if (!resolved.startsWith(home + "/") && resolved !== home) {
            res.statusCode = 403
            res.end(JSON.stringify({ error: `File operations restricted to home directory` }))
            return
          }
          // Extra safety: block known system directories even if somehow under home
          if (FORBIDDEN_PREFIXES.some(p => resolved.startsWith(p))) {
            res.statusCode = 403
            res.end(JSON.stringify({ error: `Cannot modify system files` }))
            return
          }
        }

        // Track original file contents for rollback (filePath → original content)
        const originalContents = new Map<string, { content: string; existed: boolean }>()
        // In-memory file buffers: apply all edits per file before writing
        const fileBuffers = new Map<string, string>()
        // Files marked for deletion
        const filesToDelete = new Set<string>()

        try {
          // First pass: apply all edits in memory
          for (const op of operations) {
            if (op.type === "reverse-edit" || op.type === "apply-edit") {
              // Read from buffer if we already have this file, otherwise read from disk
              let content: string
              if (fileBuffers.has(op.filePath)) {
                content = fileBuffers.get(op.filePath)!
              } else {
                content = await readFile(op.filePath, "utf-8")
                originalContents.set(op.filePath, { content, existed: true })
              }

              if (op.oldString) {
                if (op.replaceAll) {
                  // replaceAll: verify at least one occurrence exists
                  if (!content.includes(op.oldString)) {
                    throw new Error(
                      `Conflict: expected string not found in ${op.filePath}. File may have been modified externally.`
                    )
                  }
                  content = content.split(op.oldString).join(op.newString!)
                } else {
                  // Single replace: verify exactly one occurrence
                  const occurrences = content.split(op.oldString).length - 1
                  if (occurrences === 0) {
                    throw new Error(
                      `Conflict: expected string not found in ${op.filePath}. File may have been modified externally.`
                    )
                  }
                  if (occurrences > 1) {
                    throw new Error(
                      `Conflict: expected exactly 1 occurrence in ${op.filePath}, found ${occurrences}. Cannot safely apply edit.`
                    )
                  }
                  content = content.replace(op.oldString, op.newString!)
                }
              }

              fileBuffers.set(op.filePath, content)
              filesToDelete.delete(op.filePath)

            } else if (op.type === "delete-write") {
              if (!originalContents.has(op.filePath)) {
                try {
                  const content = await readFile(op.filePath, "utf-8")
                  originalContents.set(op.filePath, { content, existed: true })
                } catch {
                  originalContents.set(op.filePath, { content: "", existed: false })
                }
              }
              fileBuffers.delete(op.filePath)
              filesToDelete.add(op.filePath)

            } else if (op.type === "create-write") {
              if (!originalContents.has(op.filePath)) {
                try {
                  const existing = await readFile(op.filePath, "utf-8")
                  originalContents.set(op.filePath, { content: existing, existed: true })
                } catch {
                  originalContents.set(op.filePath, { content: "", existed: false })
                }
              }
              fileBuffers.set(op.filePath, op.content!)
              filesToDelete.delete(op.filePath)
            }
          }

          // Second pass: write all changes to disk
          for (const filePath of filesToDelete) {
            const orig = originalContents.get(filePath)
            if (orig?.existed) {
              await unlink(filePath)
            }
          }
          for (const [filePath, content] of fileBuffers) {
            await writeFile(filePath, content, "utf-8")
          }

          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ success: true, applied: operations.length }))

        } catch (err) {
          // Rollback: restore all files to their original state
          for (const [filePath, orig] of originalContents) {
            try {
              if (orig.existed) {
                await writeFile(filePath, orig.content, "utf-8")
              } else {
                // File didn't exist before — remove if it was created
                try { await unlink(filePath) } catch { /* may not exist */ }
              }
            } catch {
              // Best-effort rollback
            }
          }

          res.statusCode = 409
          res.end(JSON.stringify({
            error: String(err instanceof Error ? err.message : err),
            rolledBack: originalContents.size,
          }))
        }
      } catch {
        res.statusCode = 400
        res.end(JSON.stringify({ error: "Invalid JSON body" }))
      }
    })
  })

  // POST /api/undo/truncate-jsonl - remove lines from a JSONL file (for branching)
  use("/api/undo/truncate-jsonl", (req, res, next) => {
    if (req.method !== "POST") return next()

    let body = ""
    req.on("data", (chunk: string) => { body += chunk })
    req.on("end", async () => {
      try {
        const { dirName, fileName, keepLines } = JSON.parse(body) as {
          dirName: string
          fileName: string
          keepLines: number
        }

        const filePath = join(dirs.PROJECTS_DIR, dirName, fileName)
        if (!isWithinDir(dirs.PROJECTS_DIR, filePath)) {
          res.statusCode = 403
          res.end(JSON.stringify({ error: "Access denied" }))
          return
        }

        const content = await readFile(filePath, "utf-8")
        const lines = content.split("\n").filter(Boolean)

        if (keepLines >= lines.length) {
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ success: true, removedLines: [] }))
          return
        }

        const removedLines = lines.slice(keepLines)
        const keptContent = lines.slice(0, keepLines).join("\n") + "\n"
        await writeFile(filePath, keptContent, "utf-8")

        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ success: true, removedLines }))
      } catch (err) {
        res.statusCode = 500
        res.end(JSON.stringify({ error: String(err) }))
      }
    })
  })

  // POST /api/undo/append-jsonl - append JSONL lines back to a file (for redo)
  use("/api/undo/append-jsonl", (req, res, next) => {
    if (req.method !== "POST") return next()

    let body = ""
    req.on("data", (chunk: string) => { body += chunk })
    req.on("end", async () => {
      try {
        const { dirName, fileName, lines } = JSON.parse(body) as {
          dirName: string
          fileName: string
          lines: string[]
        }

        const filePath = join(dirs.PROJECTS_DIR, dirName, fileName)
        if (!isWithinDir(dirs.PROJECTS_DIR, filePath)) {
          res.statusCode = 403
          res.end(JSON.stringify({ error: "Access denied" }))
          return
        }

        if (!Array.isArray(lines) || lines.length === 0) {
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ success: true, appended: 0 }))
          return
        }

        const content = lines.join("\n") + "\n"
        await appendFile(filePath, content, "utf-8")

        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ success: true, appended: lines.length }))
      } catch (err) {
        res.statusCode = 500
        res.end(JSON.stringify({ error: String(err) }))
      }
    })
  })
}
