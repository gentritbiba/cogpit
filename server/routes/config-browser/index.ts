import { readFile, writeFile, unlink, mkdir, rename } from "node:fs/promises"
import { resolve, dirname, basename, join } from "node:path"
import type { UseFn } from "../../helpers"
import { isAllowedConfigPath, isUserOwned, templates } from "./configValidation"
import { buildGlobalSection, buildProjectSection, buildPluginSections } from "./configTree"
import type { ConfigTreeSection } from "./configTree"

// ── Re-exports ─────────────────────────────────────────────────────────

export type { ConfigTreeItem, ConfigTreeSection } from "./configTree"
export { scanDir, buildGlobalSection, buildProjectSection, buildPluginSections } from "./configTree"
export { isAllowedConfigPath, isUserOwned, getFileType, templates } from "./configValidation"

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

      if (!isAllowedConfigPath(filePath)) {
        res.statusCode = 403
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ error: "Access denied: not inside a .claude directory" }))
        return
      }

      try {
        const content = await readFile(resolve(filePath), "utf-8")
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ content, path: resolve(filePath) }))
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

          if (!isUserOwned(filePath)) {
            res.statusCode = 403
            res.setHeader("Content-Type", "application/json")
            res.end(JSON.stringify({ error: "Cannot write to plugin files" }))
            return
          }

          await writeFile(resolve(filePath), content, "utf-8")
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

      if (!isUserOwned(filePath)) {
        res.statusCode = 403
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ error: "Cannot delete plugin files" }))
        return
      }

      try {
        await unlink(resolve(filePath))
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
        if (!oldPath || !newName) {
          res.statusCode = 400
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ error: "oldPath and newName required" }))
          return
        }

        // Prevent path traversal
        if (newName.includes('/') || newName.includes('\\') || newName.includes('..')) {
          res.statusCode = 400
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ error: "Invalid name" }))
          return
        }

        if (!isUserOwned(oldPath)) {
          res.statusCode = 403
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ error: "Cannot rename plugin files" }))
          return
        }

        const resolvedOld = resolve(oldPath)
        const oldName = basename(resolvedOld)

        // For skills (SKILL.md), rename the parent directory
        if (oldName === "SKILL.md") {
          const oldDir = dirname(resolvedOld)
          const parentDir = dirname(oldDir)
          const newDir = join(parentDir, newName)
          await rename(oldDir, newDir)
          const newPath = join(newDir, "SKILL.md")
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ ok: true, newPath }))
        } else {
          // For regular files, rename the file itself
          const dir = dirname(resolvedOld)
          // Preserve the original extension if the user didn't provide one
          const oldExt = oldName.includes(".") ? oldName.slice(oldName.lastIndexOf(".")) : ""
          const hasExt = newName.includes(".")
          const finalName = hasExt ? newName : `${newName}${oldExt}`
          const newPath = join(dir, finalName)
          await rename(resolvedOld, newPath)
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ ok: true, newPath }))
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
        if (!dir || !fileType || !name) {
          res.statusCode = 400
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ error: "dir, fileType, and name required" }))
          return
        }

        if (!isUserOwned(dir)) {
          res.statusCode = 403
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ error: "Cannot create files in plugin directories" }))
          return
        }

        let filePath: string
        let content = templates[fileType] || ""

        if (fileType === "skill") {
          // Skills go in dir/name/SKILL.md
          const skillDir = join(dir, name)
          await mkdir(skillDir, { recursive: true })
          filePath = join(skillDir, "SKILL.md")
          content = content.replace("my-skill", name).replace("What this skill does", `${name} skill`)
        } else if (fileType === "agent") {
          filePath = join(dir, `${name}.md`)
          content = content.replace("my-agent", name).replace("What this agent does", `${name} agent`)
        } else if (fileType === "command") {
          filePath = join(dir, `${name}.md`)
          content = content.replace("My custom command", `${name} command`)
        } else {
          filePath = join(dir, name.endsWith(".md") ? name : `${name}.md`)
        }

        // Ensure parent directory exists
        await mkdir(dirname(filePath), { recursive: true })
        await writeFile(filePath, content, "utf-8")

        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ ok: true, path: filePath, content }))
      } catch {
        res.statusCode = 500
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ error: "Failed to create file" }))
      }
    })
  })
}
