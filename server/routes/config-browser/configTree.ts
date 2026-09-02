import { readdir, readFile, stat, lstat, realpath, access } from "node:fs/promises"
import { constants } from "node:fs"
import { join } from "node:path"
import { parseFrontmatter } from "../slash-suggestions"
import { hasExecutableExtension } from "../../lib/binaryResolver"
import { getFileType, type ConfigFileType } from "./configValidation"
import { globalLayout, projectLayout, mergeCliItems } from "./configSources"
import type {
  ConfigCli,
  ConfigScopeLayout,
  ConfigTreeItem,
  ConfigTreeSection,
  CliSourceDir,
  CliSourceFile,
} from "./configTypes"

export type { ConfigTreeItem, ConfigTreeSection } from "./configTypes"

/**
 * Windows has no execute bit, and fs.access(X_OK) degrades to an existence
 * check there — every file in bin/ would look runnable.
 */
async function isExecutableFile(fullPath: string, fileName: string): Promise<boolean> {
  if (process.platform === "win32") return hasExecutableExtension(fileName)
  try {
    await access(fullPath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

// ── Types ──────────────────────────────────────────────────────────────

interface ScanDirOptions {
  readOnly?: boolean
  isSkillsDir?: boolean
  isMonitorsDir?: boolean
  isBinDir?: boolean
  isThemesDir?: boolean
  /**
   * Set when recursing into a directory inside a skills root. Loose files are
   * noise at the root but are the only way to show a skill missing its SKILL.md.
   */
  includeLooseFiles?: boolean
  cli?: ConfigCli[]
}

/** Canonical target of an entry reached through a symlink, if it moved. */
async function resolveLinkTarget(path: string): Promise<string | undefined> {
  const target = await realpath(path).catch(() => null)
  return target && target !== path ? target : undefined
}

// ── Directory scanner ──────────────────────────────────────────────────

async function scanChildDirectory(
  name: string,
  path: string,
  opts: ScanDirOptions,
): Promise<ConfigTreeItem | null> {
  const children = await scanDir(path, opts)
  if (children.length === 0) return null
  return {
    name,
    path,
    type: "directory",
    children,
    readOnly: opts.readOnly,
    cli: opts.cli,
  }
}

/** Scan a directory and build tree items */
export async function scanDir(
  dir: string,
  opts: ScanDirOptions = {},
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
              cli: opts.cli,
              linkTarget: resolved ? await resolveLinkTarget(skillPath) : undefined,
            })
          } catch {
            // Not a valid skill dir — still show the directory, which may hold
            // either a malformed skill or a nested group of real skills.
            const directory = await scanChildDirectory(entry.name, fullPath, {
              ...opts,
              includeLooseFiles: true,
            })
            if (directory) items.push(directory)
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
            cli: opts.cli,
          })
        } else {
          const directory = await scanChildDirectory(entry.name, fullPath, opts)
          if (directory) items.push(directory)
        }
      } else if (entry.isFile() || resolved?.isFile()) {
        // A skills root holds skill directories; loose files beside them
        // (README.md, marker files) are not configuration.
        if (opts.isSkillsDir && !opts.includeLooseFiles) continue
        if (opts.isBinDir) {
          // bin/ entries: only include executable files
          if (await isExecutableFile(fullPath, entry.name)) {
            items.push({
              name: entry.name,
              path: fullPath,
              type: "file",
              fileType: "bin",
              readOnly: opts.readOnly,
              cli: opts.cli,
              linkTarget: resolved ? await resolveLinkTarget(fullPath) : undefined,
            })
          }
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
          cli: opts.cli,
          linkTarget: resolved ? await resolveLinkTarget(fullPath) : undefined,
        })
      }
    }
  } catch { /* directory doesn't exist */ }
  return items
}

// ── Section builders ───────────────────────────────────────────────────

/** Build a tree item for a single known config file, following a symlink to it. */
async function buildFileItem(
  source: CliSourceFile,
  fileType: ConfigFileType,
): Promise<ConfigTreeItem | null> {
  let info
  try {
    info = await lstat(source.path)
  } catch {
    return null
  }

  let linkTarget: string | undefined
  if (info.isSymbolicLink()) {
    // A broken link points at nothing editable — leave it out.
    const target = await realpath(source.path).catch(() => null)
    if (!target) return null
    linkTarget = target !== source.path ? target : undefined
  } else if (!info.isFile()) {
    return null
  }

  return {
    name: source.name,
    path: source.path,
    type: "file",
    fileType,
    cli: source.cli,
    linkTarget,
  }
}

/** Scan every CLI's copy of one directory and merge entries that share a target. */
async function buildMergedDirectory(
  name: string,
  sources: CliSourceDir[],
  opts: Omit<ScanDirOptions, "cli"> = {},
): Promise<ConfigTreeItem | null> {
  if (sources.length === 0) return null
  const groups = await Promise.all(
    sources.map((source) => scanDir(source.dir, { ...opts, cli: source.cli })),
  )
  const children = await mergeCliItems(groups)
  if (children.length === 0) return null
  children.sort((a, b) => a.name.localeCompare(b.name))
  return {
    name,
    path: sources[0].dir,
    type: "directory",
    children,
    readOnly: opts.readOnly,
  }
}

async function buildScopeItems(layout: ConfigScopeLayout): Promise<ConfigTreeItem[]> {
  const [instructions, settings, agents, commands, skills, themes] = await Promise.all([
    Promise.all(layout.instructions.map((file) => buildFileItem(file, "instructions"))),
    Promise.all(layout.settings.map((file) => buildFileItem(file, "settings"))),
    buildMergedDirectory("agents", layout.agents),
    buildMergedDirectory("commands", layout.commands),
    buildMergedDirectory("skills", layout.skills, { isSkillsDir: true }),
    buildMergedDirectory("themes", layout.themes, { isThemesDir: true }),
  ])

  // Shared setups link one CLI's instruction file at another's, so the two
  // files collapse into one entry carrying both CLIs.
  const items = await mergeCliItems([
    [...instructions, ...settings].filter((item): item is ConfigTreeItem => item !== null),
  ])

  for (const directory of [agents, commands, skills, themes]) {
    if (directory) items.push(directory)
  }
  return items
}

/** Build the global section tree */
export async function buildGlobalSection(): Promise<ConfigTreeSection> {
  const layout = globalLayout()
  const items = await buildScopeItems(layout)
  return { label: "Global", scope: "global", baseDir: layout.baseDir, items }
}

/** Build the project section tree */
export async function buildProjectSection(cwd: string): Promise<ConfigTreeSection> {
  const layout = projectLayout(cwd)
  const items = await buildScopeItems(layout)
  return { label: "Project", scope: "project", baseDir: layout.baseDir, items }
}

/**
 * Installed-plugin trees, one section per plugin. Everything a plugin ships is
 * read-only: it belongs to the plugin, not to the user.
 */
export async function buildPluginSections(): Promise<ConfigTreeSection[]> {
  const sections: ConfigTreeSection[] = []
  for (const source of globalLayout().plugins) {
    sections.push(...await buildPluginSectionsUnder(source))
  }
  return sections
}

async function buildPluginSectionsUnder(source: CliSourceDir): Promise<ConfigTreeSection[]> {
  const sections: ConfigTreeSection[] = []
  const installedPath = join(source.dir, "installed_plugins.json")
  const cli = source.cli

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
      const skills = await scanDir(skillsDir, { readOnly: true, isSkillsDir: true, cli })
      if (skills.length > 0) {
        items.push({ name: "skills", path: skillsDir, type: "directory", children: skills, readOnly: true })
      }

      // commands/
      const commandsDir = join(installPath, "commands")
      const commands = await scanDir(commandsDir, { readOnly: true, cli })
      if (commands.length > 0) {
        items.push({ name: "commands", path: commandsDir, type: "directory", children: commands, readOnly: true })
      }

      // agents/
      const agentsDir = join(installPath, "agents")
      const agents = await scanDir(agentsDir, { readOnly: true, cli })
      if (agents.length > 0) {
        items.push({ name: "agents", path: agentsDir, type: "directory", children: agents, readOnly: true })
      }

      // themes/ (since Claude Code 2.1.118)
      const pluginThemesDir = join(installPath, "themes")
      const pluginThemes = await scanDir(pluginThemesDir, { readOnly: true, isThemesDir: true, cli })
      if (pluginThemes.length > 0) {
        items.push({ name: "themes", path: pluginThemesDir, type: "directory", children: pluginThemes, readOnly: true })
      }

      // monitors/ (each subdir is a monitor)
      const monitorsDir = join(installPath, "monitors")
      const monitors = await scanDir(monitorsDir, { readOnly: true, isMonitorsDir: true, cli })
      if (monitors.length > 0) {
        items.push({ name: "monitors", path: monitorsDir, type: "directory", children: monitors, readOnly: true })
      }

      // bin/ (executable files only)
      const binDir = join(installPath, "bin")
      const bins = await scanDir(binDir, { readOnly: true, isBinDir: true, cli })
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
