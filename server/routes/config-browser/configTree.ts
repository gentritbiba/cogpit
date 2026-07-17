import { readdir, readFile, stat, access } from "node:fs/promises"
import { constants } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { parseFrontmatter } from "../slash-suggestions"
import { getFileType, type ConfigFileType } from "./configValidation"

// ── Types ──────────────────────────────────────────────────────────────

export interface ConfigTreeItem {
  name: string
  path: string
  type: "file" | "directory"
  fileType?: ConfigFileType
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
  opts: { readOnly?: boolean; isSkillsDir?: boolean; isMonitorsDir?: boolean; isBinDir?: boolean; isThemesDir?: boolean } = {},
): Promise<ConfigTreeItem[]> {
  const items: ConfigTreeItem[] = []
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      // Follow symlinks: stat() resolves symlinks to determine target type
      const resolved = entry.isSymbolicLink() ? await stat(fullPath).catch(() => null) : null
      const isDir = entry.isDirectory() || resolved?.isDirectory()
      if (isDir) {
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
        } else if (opts.isMonitorsDir) {
          // Monitors: each subdir is a monitor; read manifest.json for description if present
          let description = ""
          const manifestPath = join(fullPath, "manifest.json")
          try {
            const raw = await readFile(manifestPath, "utf-8")
            const manifest = JSON.parse(raw)
            description = manifest.description || manifest.name || ""
          } catch { /* no manifest — use empty description */ }
          items.push({
            name: entry.name,
            path: fullPath,
            type: "file",
            fileType: "monitor",
            description,
            readOnly: opts.readOnly,
          })
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
      } else if (entry.isFile() || resolved?.isFile()) {
        if (opts.isBinDir) {
          // bin/ entries: only include executable files
          try {
            await access(fullPath, constants.X_OK)
            items.push({
              name: entry.name,
              path: fullPath,
              type: "file",
              fileType: "bin",
              readOnly: opts.readOnly,
            })
          } catch { /* not executable — skip */ }
          continue
        }

        // Skip non-relevant files (only .md and .json for normal dirs)
        if (!entry.name.endsWith(".md") && !entry.name.endsWith(".json")) continue
        // Skip installed_plugins.json, config.local.json etc at top level
        if (entry.name === "installed_plugins.json") continue

        let description = ""
        // Theme files: *.json files when the caller signals this is a themes directory
        const fileType = (opts.isThemesDir && entry.name.endsWith(".json"))
          ? "theme"
          : getFileType(fullPath, dir)
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

  // themes/ (since Claude Code 2.1.118)
  const themesDir = join(globalDir, "themes")
  const themes = await scanDir(themesDir, { isThemesDir: true })
  if (themes.length > 0) {
    items.push({ name: "themes", path: themesDir, type: "directory", children: themes })
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

      // themes/ (since Claude Code 2.1.118)
      const pluginThemesDir = join(installPath, "themes")
      const pluginThemes = await scanDir(pluginThemesDir, { readOnly: true, isThemesDir: true })
      if (pluginThemes.length > 0) {
        items.push({ name: "themes", path: pluginThemesDir, type: "directory", children: pluginThemes, readOnly: true })
      }

      // monitors/ (each subdir is a monitor)
      const monitorsDir = join(installPath, "monitors")
      const monitors = await scanDir(monitorsDir, { readOnly: true, isMonitorsDir: true })
      if (monitors.length > 0) {
        items.push({ name: "monitors", path: monitorsDir, type: "directory", children: monitors, readOnly: true })
      }

      // bin/ (executable files only)
      const binDir = join(installPath, "bin")
      const bins = await scanDir(binDir, { readOnly: true, isBinDir: true })
      if (bins.length > 0) {
        items.push({ name: "bin", path: binDir, type: "directory", children: bins, readOnly: true })
      }

      if (items.length > 0) {
        sections.push({ label: pluginName, scope: "plugin", pluginName, items })
      }
    }
  } catch { /* no plugins */ }

  return sections
}
