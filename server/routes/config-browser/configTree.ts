import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import { parseFrontmatter } from "../slash-suggestions"
import { getFileType } from "./configValidation"

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

// ── Directory scanner ──────────────────────────────────────────────────

/** Scan a directory and build tree items */
export async function scanDir(
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

// ── Section builders ───────────────────────────────────────────────────

/** Build the global section tree */
export async function buildGlobalSection(): Promise<ConfigTreeSection> {
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
export async function buildProjectSection(cwd: string): Promise<ConfigTreeSection> {
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
export async function buildPluginSections(): Promise<ConfigTreeSection[]> {
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
