import { readFile } from "../helpers"
import type { UseFn } from "../http"
import { resolveEncodedUndoStatePath } from "./undo/paths"
import { registerUndoTransactionRoute } from "./undo/transaction"

export function registerUndoRoutes(use: UseFn) {
  registerUndoTransactionRoute(use)
  // GET /api/undo-state/:sessionId — read the persisted undo history.
  // Writes go through /api/undo/transaction, which commits the file
  // operations, the transcript edit and this state as one mutation; a
  // standalone write could only ever leave the three out of step.
  use("/api/undo-state/", async (req, res, next) => {
    if (req.method !== "GET") return next()

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

    try {
      const content = await readFile(filePath, "utf-8")
      res.setHeader("Content-Type", "application/json")
      res.end(content)
    } catch {
      // Return 200 with null to avoid browser console noise from 404s
      res.setHeader("Content-Type", "application/json")
      res.end("null")
    }
  })
}
