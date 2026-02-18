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

        // Track applied operations for rollback
        const applied: Array<{
          type: string
          filePath: string
          previousContent?: string
          fileExisted: boolean
        }> = []

        try {
          for (const op of operations) {
            if (op.type === "reverse-edit" || op.type === "apply-edit") {
              // Read current file content
              const content = await readFile(op.filePath, "utf-8")

              // Verify exactly one occurrence of the expected string
              if (op.oldString) {
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
              }

              // Apply the edit (safe since we verified exactly one occurrence)
              const updated = content.replace(op.oldString!, op.newString!)
              applied.push({ type: op.type, filePath: op.filePath, previousContent: content, fileExisted: true })
              await writeFile(op.filePath, updated, "utf-8")

            } else if (op.type === "delete-write") {
              // Verify file content matches before deleting
              let fileExisted = true
              try {
                const content = await readFile(op.filePath, "utf-8")
                applied.push({ type: op.type, filePath: op.filePath, previousContent: content, fileExisted: true })
              } catch {
                fileExisted = false
                applied.push({ type: op.type, filePath: op.filePath, fileExisted: false })
              }
              if (fileExisted) {
                await unlink(op.filePath)
              }

            } else if (op.type === "create-write") {
              // Check if file already exists
              let fileExisted = false
              let previousContent: string | undefined
              try {
                previousContent = await readFile(op.filePath, "utf-8")
                fileExisted = true
              } catch {
                fileExisted = false
              }
              applied.push({ type: op.type, filePath: op.filePath, previousContent, fileExisted })
              await writeFile(op.filePath, op.content!, "utf-8")
            }
          }

          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ success: true, applied: applied.length }))

        } catch (err) {
          // Rollback all applied operations
          for (let i = applied.length - 1; i >= 0; i--) {
            const a = applied[i]
            try {
              if (a.type === "reverse-edit" || a.type === "apply-edit") {
                if (a.previousContent !== undefined) {
                  await writeFile(a.filePath, a.previousContent, "utf-8")
                }
              } else if (a.type === "delete-write") {
                if (a.previousContent !== undefined) {
                  await writeFile(a.filePath, a.previousContent, "utf-8")
                }
              } else if (a.type === "create-write") {
                if (a.fileExisted && a.previousContent !== undefined) {
                  await writeFile(a.filePath, a.previousContent, "utf-8")
                } else if (!a.fileExisted) {
                  try { await unlink(a.filePath) } catch { /* file may not exist */ }
                }
              }
            } catch {
              // Best-effort rollback
            }
          }

          res.statusCode = 409
          res.end(JSON.stringify({
            error: String(err instanceof Error ? err.message : err),
            rolledBack: applied.length,
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
