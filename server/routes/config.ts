import type { UseFn } from "../helpers"
import { refreshDirs } from "../helpers"
import { getConfig, saveConfig, validateClaudeDir } from "../config"

export function registerConfigRoutes(use: UseFn) {
  // GET /api/config/validate?path=... - validate a path without saving
  use("/api/config/validate", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const dirPath = url.searchParams.get("path")

    if (!dirPath) {
      res.statusCode = 400
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({ valid: false, error: "path query param required" }))
      return
    }

    const result = await validateClaudeDir(dirPath)
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify(result))
  })

  // GET /api/config - return current config (or null)
  // POST /api/config - validate and save config
  use("/api/config", async (req, res, next) => {
    if (req.method === "GET") {
      // Only handle exact path
      if (req.url && req.url !== "/" && req.url !== "" && !req.url.startsWith("?")) return next()
      const config = getConfig()
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify(config))
      return
    }

    if (req.method === "POST") {
      let body = ""
      req.on("data", (chunk: Buffer) => { body += chunk.toString() })
      req.on("end", async () => {
        try {
          const { claudeDir } = JSON.parse(body)
          if (!claudeDir || typeof claudeDir !== "string") {
            res.statusCode = 400
            res.setHeader("Content-Type", "application/json")
            res.end(JSON.stringify({ error: "claudeDir string required" }))
            return
          }

          const validation = await validateClaudeDir(claudeDir)
          if (!validation.valid) {
            res.statusCode = 400
            res.setHeader("Content-Type", "application/json")
            res.end(JSON.stringify({ error: validation.error }))
            return
          }

          await saveConfig({ claudeDir: validation.resolved || claudeDir })
          refreshDirs()

          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ success: true, claudeDir: validation.resolved || claudeDir }))
        } catch {
          res.statusCode = 400
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ error: "Invalid JSON body" }))
        }
      })
      return
    }

    next()
  })
}
