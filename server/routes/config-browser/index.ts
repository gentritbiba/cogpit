import { readFile, writeFile, unlink, mkdir, rename } from "node:fs/promises"
import { dirname, basename, join } from "node:path"
import { sendJson, type UseFn } from "../../http"
import {
  isSafeConfigName,
  resolveConfigBrowserPath,
  templates,
} from "./configValidation"
import { buildGlobalSection, buildProjectSection, buildPluginSections } from "./configTree"
import type { ConfigTreeSection } from "./configTree"

// ── Route registration ────────────────────────────────────────────────

export function registerConfigBrowserRoutes(use: UseFn) {
  // GET /api/config-browser/tree?cwd=<projectPath>
  use("/api/config-browser/tree", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const cwd = url.searchParams.get("cwd") || ""

    const [globalSection, projectSection, pluginSections] = await Promise.all([
      buildGlobalSection(),
      cwd ? buildProjectSection(cwd) : Promise.resolve(null),
      buildPluginSections(),
    ])

    const sections: ConfigTreeSection[] = [globalSection]
    if (projectSection && projectSection.items.length > 0) {
      sections.push(projectSection)
    }
    sections.push(...pluginSections)

    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ sections }))
  })

  // GET /api/config-browser/file?path=<filePath>
  use("/api/config-browser/file", async (req, res, next) => {
    if (req.method === "GET") {
      const url = new URL(req.url || "/", "http://localhost")
      const filePath = url.searchParams.get("path") || ""

      if (!filePath) {
        res.statusCode = 400
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ error: "path required" }))
        return
      }

      const safePath = await resolveConfigBrowserPath(filePath, { allowMissing: true })
      if (!safePath) {
        sendJson(res, 403, { error: "Access denied: unsafe config path" })
        return
      }

      try {
        const content = await readFile(safePath.canonicalPath, "utf-8")
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ content, path: safePath.resolvedPath }))
      } catch {
        res.statusCode = 404
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ error: "File not found" }))
      }
      return
    }

    // POST /api/config-browser/file — save file
    if (req.method === "POST") {
      let body = ""
      req.on("data", (chunk: Buffer) => { body += chunk.toString() })
      req.on("end", async () => {
        try {
          const { path: filePath, content } = JSON.parse(body)
          if (!filePath || typeof content !== "string") {
            res.statusCode = 400
            res.setHeader("Content-Type", "application/json")
            res.end(JSON.stringify({ error: "path and content required" }))
            return
          }

          const safePath = await resolveConfigBrowserPath(filePath, {
            allowMissing: true,
            writable: true,
          })
          if (!safePath) {
            sendJson(res, 403, { error: "Access denied: config path is not writable" })
            return
          }

          await writeFile(safePath.canonicalPath, content, "utf-8")
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ ok: true }))
        } catch {
          res.statusCode = 400
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ error: "Invalid request" }))
        }
      })
      return
    }

    // DELETE /api/config-browser/file?path=<filePath>
    if (req.method === "DELETE") {
      const url = new URL(req.url || "/", "http://localhost")
      const filePath = url.searchParams.get("path") || ""

      if (!filePath) {
        res.statusCode = 400
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ error: "path required" }))
        return
      }

      const safePath = await resolveConfigBrowserPath(filePath, {
        allowMissing: true,
        writable: true,
      })
      if (!safePath) {
        sendJson(res, 403, { error: "Access denied: config path is not writable" })
        return
      }

      try {
        // Delete the validated directory entry rather than following an
        // in-root symlink and deleting its target.
        await unlink(safePath.resolvedPath)
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ ok: true }))
      } catch {
        res.statusCode = 404
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ error: "File not found" }))
      }
      return
    }

    next()
  })

  // POST /api/config-browser/rename — rename a config file
  use("/api/config-browser/rename", async (req, res, next) => {
    if (req.method !== "POST") return next()

    let body = ""
    req.on("data", (chunk: Buffer) => { body += chunk.toString() })
    req.on("end", async () => {
      try {
        const { oldPath, newName } = JSON.parse(body)
        if (typeof oldPath !== "string" || typeof newName !== "string") {
          res.statusCode = 400
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ error: "oldPath and newName required" }))
          return
        }

        const trimmedName = newName.trim()
        if (!isSafeConfigName(trimmedName)) {
          sendJson(res, 400, { error: "Invalid name" })
          return
        }

        const safeOldPath = await resolveConfigBrowserPath(oldPath, {
          allowMissing: true,
          writable: true,
        })
        if (!safeOldPath) {
          sendJson(res, 403, { error: "Access denied: config path is not writable" })
          return
        }

        const resolvedOld = safeOldPath.resolvedPath
        const oldName = basename(resolvedOld)

        // For skills (SKILL.md), rename the parent directory
        if (oldName === "SKILL.md") {
          const oldDir = dirname(resolvedOld)
          const parentDir = dirname(oldDir)
          const newDir = join(parentDir, trimmedName)
          const safeNewDir = await resolveConfigBrowserPath(newDir, {
            allowMissing: true,
            writable: true,
            requireClaudeDirectory: true,
          })
          if (!safeNewDir) {
            sendJson(res, 400, { error: "Invalid destination" })
            return
          }
          await rename(oldDir, safeNewDir.resolvedPath)
          const newPath = join(safeNewDir.resolvedPath, "SKILL.md")
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ ok: true, newPath }))
        } else {
          // For regular files, rename the file itself
          const dir = dirname(resolvedOld)
          // Preserve the original extension if the user didn't provide one
          const oldExt = oldName.includes(".") ? oldName.slice(oldName.lastIndexOf(".")) : ""
          const hasExt = trimmedName.includes(".")
          const finalName = hasExt ? trimmedName : `${trimmedName}${oldExt}`
          const newPath = join(dir, finalName)
          const safeNewPath = await resolveConfigBrowserPath(newPath, {
            allowMissing: true,
            writable: true,
          })
          if (!safeNewPath) {
            sendJson(res, 400, { error: "Invalid destination" })
            return
          }
          await rename(resolvedOld, safeNewPath.resolvedPath)
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ ok: true, newPath: safeNewPath.resolvedPath }))
        }
      } catch {
        res.statusCode = 500
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ error: "Failed to rename file" }))
      }
    })
  })

  // POST /api/config-browser/create — create new file from template
  use("/api/config-browser/create", async (req, res, next) => {
    if (req.method !== "POST") return next()

    let body = ""
    req.on("data", (chunk: Buffer) => { body += chunk.toString() })
    req.on("end", async () => {
      try {
        const { dir, fileType, name } = JSON.parse(body)
        if (typeof dir !== "string" || typeof fileType !== "string" || typeof name !== "string") {
          res.statusCode = 400
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ error: "dir, fileType, and name required" }))
          return
        }

        const trimmedName = name.trim()
        if (!isSafeConfigName(trimmedName)) {
          sendJson(res, 400, { error: "Invalid name" })
          return
        }
        if (fileType !== "skill" && fileType !== "agent" && fileType !== "command") {
          sendJson(res, 400, { error: "Invalid file type" })
          return
        }

        const safeDir = await resolveConfigBrowserPath(dir, {
          allowMissing: true,
          writable: true,
          requireClaudeDirectory: true,
        })
        if (!safeDir) {
          sendJson(res, 403, { error: "Access denied: config directory is not writable" })
          return
        }

        let filePath: string
        let content = templates[fileType]

        if (fileType === "skill") {
          // Skills go in dir/name/SKILL.md
          const skillDir = join(safeDir.resolvedPath, trimmedName)
          filePath = join(skillDir, "SKILL.md")
          content = content.replace("my-skill", trimmedName).replace("What this skill does", `${trimmedName} skill`)
        } else if (fileType === "agent") {
          filePath = join(safeDir.resolvedPath, `${trimmedName}.md`)
          content = content.replace("my-agent", trimmedName).replace("What this agent does", `${trimmedName} agent`)
        } else {
          filePath = join(safeDir.resolvedPath, `${trimmedName}.md`)
          content = content.replace("My custom command", `${trimmedName} command`)
        }

        let safeFilePath = await resolveConfigBrowserPath(filePath, {
          allowMissing: true,
          writable: true,
          requireClaudeDirectory: true,
        })
        if (!safeFilePath) {
          sendJson(res, 403, { error: "Access denied: unsafe destination" })
          return
        }

        await mkdir(dirname(safeFilePath.canonicalPath), { recursive: true })
        // Re-resolve after mkdir so a pre-existing symlink in the newly visible
        // parent chain cannot redirect the final write outside the policy root.
        safeFilePath = await resolveConfigBrowserPath(filePath, {
          allowMissing: true,
          writable: true,
          requireClaudeDirectory: true,
        })
        if (!safeFilePath) {
          sendJson(res, 403, { error: "Access denied: unsafe destination" })
          return
        }
        await writeFile(safeFilePath.canonicalPath, content, "utf-8")

        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ ok: true, path: safeFilePath.resolvedPath, content }))
      } catch {
        res.statusCode = 500
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ error: "Failed to create file" }))
      }
    })
  })
}
