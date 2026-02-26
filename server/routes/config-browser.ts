import { readdir, readFile, writeFile, unlink, mkdir, stat, rename } from "node:fs/promises"
import { join, resolve, sep, dirname, basename } from "node:path"
import { homedir } from "node:os"
import type { UseFn } from "../helpers"
import { parseFrontmatter } from "./slash-suggestions"

// ── Types ──────────────────────────────────────────────────────────────

export interface ConfigTreeItem {
  name: string
  path: string
  type: "file" | "directory"
  fileType?: "command" | "skill" | "agent" | "claude-md" | "settings" | "unknown"
  description?: string
  children?: ConfigTreeItem[]
  readOnly?: boolean
}

export interface ConfigTreeSection {
  label: string
  scope: "global" | "project" | "plugin"
  pluginName?: string
  baseDir?: string
  items: ConfigTreeItem[]
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Check if a path is an allowed config file (inside .claude/ or a CLAUDE.md beside it) */
function isAllowedConfigPath(filePath: string): boolean {
  const resolved = resolve(filePath)
  const claudeSegment = `${sep}.claude${sep}`
  if (resolved.includes(claudeSegment) || resolved.endsWith(`${sep}.claude`)) return true
  // Allow project-root CLAUDE.md (sibling of .claude directory)
  if (basename(resolved) === "CLAUDE.md") return true
  return false
}

/** Check if a path is user-owned (not inside plugins/cache) */
function isUserOwned(filePath: string): boolean {
  const resolved = resolve(filePath)
  if (basename(resolved) === "CLAUDE.md") return true
  return isAllowedConfigPath(resolved) && !resolved.includes(`${sep}plugins${sep}cache${sep}`)
}

/** Get file type from path and context */
function getFileType(filePath: string, parentDir: string): ConfigTreeItem["fileType"] {
  const name = basename(filePath)
  if (name === "CLAUDE.md") return "claude-md"
  if (name === "settings.json" || name === "settings.local.json") return "settings"
  if (parentDir.includes(`${sep}agents`) || parentDir.endsWith("/agents")) return "agent"
  if (name === "SKILL.md") return "skill"
  if (parentDir.includes(`${sep}commands`) || parentDir.endsWith("/commands")) return "command"
  return "unknown"
}

/** Scan a directory and build tree items */
async function scanDir(
  dir: string,
  opts: { readOnly?: boolean; isSkillsDir?: boolean } = {},
): Promise<ConfigTreeItem[]> {
  const items: ConfigTreeItem[] = []
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (opts.isSkillsDir) {
          // Skills are dirs with SKILL.md inside
          const skillPath = join(fullPath, "SKILL.md")
          try {
            const content = await readFile(skillPath, "utf-8")
            const fm = parseFrontmatter(content)
            items.push({
              name: fm.name || entry.name,
              path: skillPath,
              type: "file",
              fileType: "skill",
              description: fm.description || "",
              readOnly: opts.readOnly,
            })
          } catch {
            // Not a valid skill dir — still show the directory
            const children = await scanDir(fullPath, opts)
            if (children.length > 0) {
              items.push({
                name: entry.name,
                path: fullPath,
                type: "directory",
                children,
                readOnly: opts.readOnly,
              })
            }
          }
        } else {
          const children = await scanDir(fullPath, opts)
          if (children.length > 0) {
            items.push({
              name: entry.name,
              path: fullPath,
              type: "directory",
              children,
              readOnly: opts.readOnly,
            })
          }
        }
      } else if (entry.isFile()) {
        // Skip non-relevant files
        if (!entry.name.endsWith(".md") && !entry.name.endsWith(".json")) continue
        // Skip installed_plugins.json, config.local.json etc at top level
        if (entry.name === "installed_plugins.json") continue

        let description = ""
        const fileType = getFileType(fullPath, dir)
        if (entry.name.endsWith(".md")) {
          try {
            const content = await readFile(fullPath, "utf-8")
            const fm = parseFrontmatter(content)
            description = fm.description || fm.name || ""
          } catch { /* skip */ }
        }
        items.push({
          name: entry.name,
          path: fullPath,
          type: "file",
          fileType,
          description,
          readOnly: opts.readOnly,
        })
      }
    }
  } catch { /* directory doesn't exist */ }
  return items
}

/** Build the global section tree */
async function buildGlobalSection(): Promise<ConfigTreeSection> {
  const globalDir = join(homedir(), ".claude")
  const items: ConfigTreeItem[] = []

  // CLAUDE.md
  const claudeMdPath = join(globalDir, "CLAUDE.md")
  try {
    await stat(claudeMdPath)
    items.push({ name: "CLAUDE.md", path: claudeMdPath, type: "file", fileType: "claude-md" })
  } catch { /* doesn't exist */ }

  // settings.json
  const settingsPath = join(globalDir, "settings.json")
  try {
    await stat(settingsPath)
    items.push({ name: "settings.json", path: settingsPath, type: "file", fileType: "settings" })
  } catch { /* doesn't exist */ }

  // agents/
  const agentsDir = join(globalDir, "agents")
  const agents = await scanDir(agentsDir)
  if (agents.length > 0) {
    items.push({ name: "agents", path: agentsDir, type: "directory", children: agents })
  }

  // commands/
  const commandsDir = join(globalDir, "commands")
  const commands = await scanDir(commandsDir)
  if (commands.length > 0) {
    items.push({ name: "commands", path: commandsDir, type: "directory", children: commands })
  }

  // skills/
  const skillsDir = join(globalDir, "skills")
  const skills = await scanDir(skillsDir, { isSkillsDir: true })
  if (skills.length > 0) {
    items.push({ name: "skills", path: skillsDir, type: "directory", children: skills })
  }

  return { label: "Global", scope: "global", baseDir: globalDir, items }
}

/** Build the project section tree */
async function buildProjectSection(cwd: string): Promise<ConfigTreeSection> {
  const projectClaudeDir = join(cwd, ".claude")
  const items: ConfigTreeItem[] = []

  // CLAUDE.md (project root)
  const claudeMdPath = join(cwd, "CLAUDE.md")
  try {
    await stat(claudeMdPath)
    items.push({ name: "CLAUDE.md", path: claudeMdPath, type: "file", fileType: "claude-md" })
  } catch { /* doesn't exist */ }

  // .claude/CLAUDE.md
  const innerClaudeMd = join(projectClaudeDir, "CLAUDE.md")
  try {
    await stat(innerClaudeMd)
    items.push({ name: ".claude/CLAUDE.md", path: innerClaudeMd, type: "file", fileType: "claude-md" })
  } catch { /* doesn't exist */ }

  // .claude/settings.local.json
  const settingsPath = join(projectClaudeDir, "settings.local.json")
  try {
    await stat(settingsPath)
    items.push({ name: "settings.local.json", path: settingsPath, type: "file", fileType: "settings" })
  } catch { /* doesn't exist */ }

  // .claude/agents/
  const agentsDir = join(projectClaudeDir, "agents")
  const agents = await scanDir(agentsDir)
  if (agents.length > 0) {
    items.push({ name: "agents", path: agentsDir, type: "directory", children: agents })
  }

  // .claude/commands/
  const commandsDir = join(projectClaudeDir, "commands")
  const commands = await scanDir(commandsDir)
  if (commands.length > 0) {
    items.push({ name: "commands", path: commandsDir, type: "directory", children: commands })
  }

  // .claude/skills/
  const skillsDir = join(projectClaudeDir, "skills")
  const skills = await scanDir(skillsDir, { isSkillsDir: true })
  if (skills.length > 0) {
    items.push({ name: "skills", path: skillsDir, type: "directory", children: skills })
  }

  return { label: "Project", scope: "project", baseDir: projectClaudeDir, items }
}

/** Build plugin sections */
async function buildPluginSections(): Promise<ConfigTreeSection[]> {
  const sections: ConfigTreeSection[] = []
  const installedPath = join(homedir(), ".claude", "plugins", "installed_plugins.json")

  try {
    const raw = await readFile(installedPath, "utf-8")
    const data = JSON.parse(raw)
    const plugins = data.plugins || {}

    for (const [pluginKey, installs] of Object.entries(plugins)) {
      const installList = installs as Array<{ installPath: string }>
      if (!installList.length) continue
      const installPath = installList[0].installPath
      const pluginName = pluginKey.split("@")[0]

      const items: ConfigTreeItem[] = []

      // skills/
      const skillsDir = join(installPath, "skills")
      const skills = await scanDir(skillsDir, { readOnly: true, isSkillsDir: true })
      if (skills.length > 0) {
        items.push({ name: "skills", path: skillsDir, type: "directory", children: skills, readOnly: true })
      }

      // commands/
      const commandsDir = join(installPath, "commands")
      const commands = await scanDir(commandsDir, { readOnly: true })
      if (commands.length > 0) {
        items.push({ name: "commands", path: commandsDir, type: "directory", children: commands, readOnly: true })
      }

      // agents/
      const agentsDir = join(installPath, "agents")
      const agents = await scanDir(agentsDir, { readOnly: true })
      if (agents.length > 0) {
        items.push({ name: "agents", path: agentsDir, type: "directory", children: agents, readOnly: true })
      }

      if (items.length > 0) {
        sections.push({ label: pluginName, scope: "plugin", pluginName, items })
      }
    }
  } catch { /* no plugins */ }

  return sections
}

// ── Templates for new files ────────────────────────────────────────────

const templates: Record<string, string> = {
  command: `---
description: My custom command
---

$ARGUMENTS
`,
  skill: `---
name: my-skill
description: What this skill does
---

# My Skill

Instructions for this skill.
`,
  agent: `---
name: my-agent
description: What this agent does
model: sonnet
---

# My Agent

Agent instructions here.
`,
  "claude-md": `# Project Instructions

Add your project-specific instructions here.
`,
}

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
