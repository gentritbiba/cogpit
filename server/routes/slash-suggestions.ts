import { readdir, readFile } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import { homedir } from "node:os"
import type { UseFn } from "../helpers"

export interface SlashSuggestion {
  name: string
  description: string
  type: "command" | "skill"
  source: "project" | "user" | string // plugin name for skills
  filePath: string
}

/** Parse YAML frontmatter from a markdown file's content */
export function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}
  const result: Record<string, string> = {}
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":")
    if (idx > 0) {
      const key = line.slice(0, idx).trim()
      const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "")
      if (key && val) result[key] = val
    }
  }
  return result
}

/** Scan a commands directory and return suggestions */
async function scanCommands(
  dir: string,
  source: "project" | "user",
): Promise<SlashSuggestion[]> {
  const results: SlashSuggestion[] = []
  try {
    const files = await readdir(dir)
    for (const file of files) {
      if (!file.endsWith(".md")) continue
      const filePath = join(dir, file)
      try {
        const content = await readFile(filePath, "utf-8")
        const fm = parseFrontmatter(content)
        results.push({
          name: file.replace(/\.md$/, ""),
          description: fm.description || "",
          type: "command",
          source,
          filePath,
        })
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    // directory doesn't exist
  }
  return results
}

/** Scan a skills directory (contains subdirs each with a SKILL.md) */
async function scanSkillsDir(
  dir: string,
  source: "project" | "user",
): Promise<SlashSuggestion[]> {
  const results: SlashSuggestion[] = []
  try {
    const entries = await readdir(dir)
    for (const entry of entries) {
      const skillMdPath = join(dir, entry, "SKILL.md")
      try {
        const content = await readFile(skillMdPath, "utf-8")
        const fm = parseFrontmatter(content)
        results.push({
          name: fm.name || entry,
          description: fm.description || "",
          type: "skill",
          source,
          filePath: skillMdPath,
        })
      } catch {
        // no SKILL.md in this subdirectory
      }
    }
  } catch {
    // directory doesn't exist
  }
  return results
}

/** Publishers whose plugins are considered built-in to Claude Code */
const BUILTIN_PUBLISHERS = new Set([
  "claude-plugins-official",
])

/**
 * Skills bundled into the Claude Code binary itself.
 * These aren't discoverable from the filesystem — they're hardcoded in the CLI.
 * Source: https://code.claude.com/docs/en/skills#bundled-skills
 */
const BUILTIN_SKILLS: SlashSuggestion[] = [
  {
    name: "simplify",
    description: "Review changed code for reuse, quality, and efficiency, then fix any issues found",
    type: "skill",
    source: "built-in",
    filePath: "",
  },
  {
    name: "batch",
    description: "Orchestrate large-scale changes across a codebase in parallel using isolated worktrees",
    type: "skill",
    source: "built-in",
    filePath: "",
  },
  {
    name: "debug",
    description: "Troubleshoot your current Claude Code session by reading the session debug log",
    type: "skill",
    source: "built-in",
    filePath: "",
  },
]

/**
 * Scan a directory for .md files and return a suggestion for each.
 * `nameFn` derives the suggestion name from the frontmatter and filename.
 */
async function scanMdFiles(
  dir: string,
  type: "command" | "skill",
  source: string,
  nameFn: (fm: Record<string, string>, file: string) => string,
): Promise<SlashSuggestion[]> {
  const results: SlashSuggestion[] = []
  try {
    const files = await readdir(dir)
    for (const file of files) {
      if (!file.endsWith(".md")) continue
      const filePath = join(dir, file)
      try {
        const content = await readFile(filePath, "utf-8")
        const fm = parseFrontmatter(content)
        results.push({
          name: nameFn(fm, file),
          description: fm.description || "",
          type,
          source,
          filePath,
        })
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    // directory doesn't exist
  }
  return results
}

/** Scan installed plugins for skills, commands, and agents */
async function scanPluginSkills(): Promise<SlashSuggestion[]> {
  const pluginsDir = join(homedir(), ".claude", "plugins")
  const installedPath = join(pluginsDir, "installed_plugins.json")

  let data: Record<string, unknown>
  try {
    const raw = await readFile(installedPath, "utf-8")
    data = JSON.parse(raw)
  } catch {
    return [] // installed_plugins.json doesn't exist
  }

  const plugins = (data.plugins || {}) as Record<string, Array<{ installPath: string }>>
  const results: SlashSuggestion[] = []

  for (const [pluginKey, installList] of Object.entries(plugins)) {
    if (!installList.length) continue
    const installPath = installList[0].installPath

    // Derive display name and publisher from key (e.g. "superpowers@superpowers-dev")
    const [pluginDisplayName, publisher = ""] = pluginKey.split("@")
    const source = BUILTIN_PUBLISHERS.has(publisher) ? "built-in" : pluginDisplayName
    const nameFromFm = (fm: Record<string, string>, file: string) =>
      fm.name || file.replace(/\.md$/, "")

    // Skills: each subdirectory contains a SKILL.md
    const skillsDir = join(installPath, "skills")
    try {
      const skillDirs = await readdir(skillsDir)
      for (const skillDir of skillDirs) {
        const skillMdPath = join(skillsDir, skillDir, "SKILL.md")
        try {
          const content = await readFile(skillMdPath, "utf-8")
          const fm = parseFrontmatter(content)
          results.push({
            name: fm.name || skillDir,
            description: fm.description || "",
            type: "skill",
            source,
            filePath: skillMdPath,
          })
        } catch {
          // no SKILL.md in this directory
        }
      }
    } catch {
      // no skills directory
    }

    // Agents: skip built-in publishers (their agents back the hardcoded BUILTIN_SKILLS)
    if (!BUILTIN_PUBLISHERS.has(publisher)) {
      const agentSuggestions = await scanMdFiles(
        join(installPath, "agents"), "skill", source, nameFromFm,
      )
      results.push(...agentSuggestions)
    }

    // Commands: namespaced as "plugin:command"
    const cmdSuggestions = await scanMdFiles(
      join(installPath, "commands"), "command", source,
      (fm, file) => `${pluginDisplayName}:${fm.name || file.replace(/\.md$/, "")}`,
    )
    results.push(...cmdSuggestions)
  }

  return results
}

/** Check if a file path is safe to read (inside a .claude directory, .md extension) */
export function isAllowedCommandPath(filePath: string): boolean {
  const resolved = resolve(filePath)
  const claudeSegment = `${sep}.claude${sep}`
  return resolved.includes(claudeSegment) && resolved.endsWith(".md")
}

/** Expand a command file: strip frontmatter, replace $ARGUMENTS */
export async function expandCommand(
  filePath: string,
  args: string,
): Promise<string | null> {
  try {
    const content = await readFile(filePath, "utf-8")
    // Strip frontmatter
    const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim()
    // Replace $ARGUMENTS placeholder
    return body.replace(/\$ARGUMENTS/g, args)
  } catch {
    return null
  }
}

export function registerSlashSuggestionRoutes(use: UseFn) {
  // GET /api/slash-suggestions?cwd=<projectPath>
  use("/api/slash-suggestions", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const cwd = url.searchParams.get("cwd") || ""

    const globalClaudeDir = join(homedir(), ".claude")

    // Scan all sources in parallel
    const [userCommands, projectCommands, userSkills, projectSkills, pluginSkills] =
      await Promise.all([
        scanCommands(join(globalClaudeDir, "commands"), "user"),
        cwd
          ? scanCommands(join(cwd, ".claude", "commands"), "project")
          : Promise.resolve([]),
        scanSkillsDir(join(globalClaudeDir, "skills"), "user"),
        cwd
          ? scanSkillsDir(join(cwd, ".claude", "skills"), "project")
          : Promise.resolve([]),
        scanPluginSkills(),
      ])

    // Deduplicate: project commands override user commands with same name
    const commandMap = new Map<string, SlashSuggestion>()
    for (const cmd of userCommands) commandMap.set(cmd.name, cmd)
    for (const cmd of projectCommands) commandMap.set(cmd.name, cmd)

    // Deduplicate skills: built-in → user → project (later wins)
    const skillMap = new Map<string, SlashSuggestion>()
    for (const s of BUILTIN_SKILLS) skillMap.set(s.name, s)
    for (const s of userSkills) skillMap.set(s.name, s)
    for (const s of projectSkills) skillMap.set(s.name, s)

    const suggestions = [...commandMap.values(), ...skillMap.values(), ...pluginSkills]

    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ suggestions }))
  })

  // POST /api/expand-command — expand a command file with arguments
  use("/api/expand-command", async (req, res, next) => {
    if (req.method !== "POST") return next()

    let body = ""
    req.on("data", (chunk: Buffer) => { body += chunk.toString() })
    req.on("end", async () => {
      try {
        const { filePath, args } = JSON.parse(body)
        if (!filePath || typeof filePath !== "string") {
          res.statusCode = 400
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ error: "filePath required" }))
          return
        }

        // Security: only allow .md files inside .claude directories
        if (!isAllowedCommandPath(filePath)) {
          res.statusCode = 403
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ error: "Access denied" }))
          return
        }

        const expanded = await expandCommand(resolve(filePath), args || "")
        if (expanded === null) {
          res.statusCode = 404
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ error: "Command file not found" }))
          return
        }

        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ content: expanded }))
      } catch {
        res.statusCode = 400
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ error: "Invalid JSON body" }))
      }
    })
  })
}
