import {
  dirs,
  readFile,
  writeFile,
  mkdir,
} from "../helpers"
import { appendFile } from "node:fs/promises"
import type { UseFn } from "../http"
import { writeOwnerOnlyJson } from "../atomicJsonFile"
import {
  commitFileOperations,
  prepareFileOperations,
  rollbackFileOperations,
  UndoOperationError,
  type PreparedFileOperations,
} from "./undo/fileOperations"
import { enqueueUndoMutation } from "./undo/mutationQueue"
import { resolveEncodedUndoStatePath, resolveUndoSessionPath } from "./undo/paths"
import { registerUndoTransactionRoute } from "./undo/transaction"

export function registerUndoRoutes(use: UseFn) {
  registerUndoTransactionRoute(use)
  // GET /api/undo-state/:sessionId - read undo state
  // POST /api/undo-state/:sessionId - save undo state
  use("/api/undo-state/", async (req, res, next) => {
    if (req.method !== "GET" && req.method !== "POST") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const parts = url.pathname.split("/").filter(Boolean)
    if (parts.length !== 1) return next()

    const filePath = resolveEncodedUndoStatePath(parts[0])
    if (!filePath) {
      res.statusCode = 403
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({ error: "Access denied" }))
      return
    }

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
    req.on("end", () => {
      void enqueueUndoMutation(async () => {
        try {
          const state = JSON.parse(body) as unknown
          await mkdir(dirs.UNDO_DIR, { recursive: true })
          await writeOwnerOnlyJson(filePath, state)
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ success: true }))
        } catch (err) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        }
      })
    })
  })

  // POST /api/undo/apply - apply a batch of file operations (undo or redo)
  use("/api/undo/apply", (req, res, next) => {
    if (req.method !== "POST") return next()

    let body = ""
    req.on("data", (chunk: string) => { body += chunk })
    req.on("end", () => {
      void enqueueUndoMutation(async () => {
        let batch: PreparedFileOperations | undefined
        try {
          const parsed = JSON.parse(body) as { operations?: unknown }
          batch = await prepareFileOperations(parsed.operations)
          await commitFileOperations(batch)
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ success: true, applied: batch.operationCount }))
        } catch (error) {
          const rollbackErrors = batch ? await rollbackFileOperations(batch) : []
          const status = error instanceof SyntaxError
            ? 400
            : error instanceof UndoOperationError
              ? error.status
              : 409
          res.statusCode = status
          res.end(JSON.stringify({
            error: error instanceof SyntaxError
              ? "Invalid JSON body"
              : error instanceof Error ? error.message : String(error),
            rolledBack: batch?.originals.size ?? 0,
            ...(rollbackErrors.length > 0 ? { rollbackErrors } : {}),
          }))
        }
      })
    })
  })

  // POST /api/undo/truncate-jsonl - remove lines from a JSONL file (for branching)
  use("/api/undo/truncate-jsonl", (req, res, next) => {
    if (req.method !== "POST") return next()

    let body = ""
    req.on("data", (chunk: string) => { body += chunk })
    req.on("end", () => {
      void enqueueUndoMutation(async () => {
        try {
        const { dirName, fileName, keepLines } = JSON.parse(body) as {
          dirName: string
          fileName: string
          keepLines: number
        }

        const filePath = await resolveUndoSessionPath(dirName, fileName)
        if (!filePath) {
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
  })

  // POST /api/undo/append-jsonl - append JSONL lines back to a file (for redo)
  use("/api/undo/append-jsonl", (req, res, next) => {
    if (req.method !== "POST") return next()

    let body = ""
    req.on("data", (chunk: string) => { body += chunk })
    req.on("end", () => {
      void enqueueUndoMutation(async () => {
        try {
        const { dirName, fileName, lines } = JSON.parse(body) as {
          dirName: string
          fileName: string
          lines: string[]
        }

        const filePath = await resolveUndoSessionPath(dirName, fileName)
        if (!filePath) {
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
  })
}
