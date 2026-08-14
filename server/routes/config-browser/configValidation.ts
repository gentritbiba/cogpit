import { lstat, realpath, stat } from "node:fs/promises"
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from "node:path"

import type { ConfigFileType } from "../../../shared/contracts/configBrowser"

export type { ConfigFileType }

/**
 * Directories that hold agent configuration: Claude Code's `.claude`, Codex
 * CLI's `.codex`, and `.agents`, the shared source of truth both CLIs symlink
 * into. A path is trusted when it lives inside one of them.
 */
const CONFIG_ROOT_DIRS = new Set([".claude", ".codex", ".agents"])

/** Instruction files that sit beside, rather than inside, a config root. */
const INSTRUCTION_FILES = new Set(["CLAUDE.md", "AGENTS.md"])

/**
 * Claude's settings files. Codex's `config.toml` is not listed: it only ever
 * reaches the tree through `buildFileItem`, which types it directly, while
 * `getFileType` is reached only for the `.md`/`.json` files a scan keeps.
 */
const SETTINGS_FILES = new Set(["settings.json", "settings.local.json"])

type ConfigPathKind = "config-directory" | "instructions-file"

interface ConfigPathPolicy {
  kind: ConfigPathKind
  resolvedPath: string
  policyRoot: string
}

export interface ConfigPathResolution {
  /** Absolute path preserving the caller-visible (possibly symlinked) location. */
  resolvedPath: string
  /** Canonical target used for reads and writes so a symlink cannot escape. */
  canonicalPath: string
}

interface ResolveConfigPathOptions {
  allowMissing?: boolean
  writable?: boolean
  requireConfigDirectory?: boolean
}

function findConfigRoot(filePath: string): string | null {
  let current = filePath
  let configRoot: string | null = null
  while (true) {
    // Keep walking after a match. Anchoring to the outermost config boundary
    // prevents a nested `.claude` symlink from redefining the trusted root.
    if (CONFIG_ROOT_DIRS.has(basename(current))) configRoot = current
    const parent = dirname(current)
    if (parent === current) return configRoot
    current = parent
  }
}

function isInstructionsFile(filePath: string): boolean {
  return INSTRUCTION_FILES.has(basename(filePath))
}

function classifyConfigPath(filePath: string): ConfigPathPolicy | null {
  if (!filePath || filePath.includes("\0")) return null

  const resolvedPath = resolve(filePath)
  const configRoot = findConfigRoot(resolvedPath)
  if (configRoot) {
    return {
      kind: "config-directory",
      resolvedPath,
      policyRoot: configRoot,
    }
  }

  // Project-root CLAUDE.md / AGENTS.md files are intentionally valid even
  // though they sit beside, rather than inside, a config directory.
  if (isInstructionsFile(resolvedPath)) {
    return {
      kind: "instructions-file",
      resolvedPath,
      policyRoot: dirname(resolvedPath),
    }
  }

  return null
}

function isWithin(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child)
  return pathFromParent === ""
    || (pathFromParent !== ".."
      && !pathFromParent.startsWith(`..${sep}`)
      && !isAbsolute(pathFromParent))
}

/**
 * Plugin caches are read-only wherever they sit. Matching the segment pair
 * rather than a cache under one known root is what makes a nested install
 * (`~/.agents/x/.claude/plugins/cache/…`) read-only too: `findConfigRoot`
 * anchors that path to the outermost root, `~/.agents`, whose own plugin cache
 * it is not inside.
 */
function isPluginCachePath(candidate: string): boolean {
  const segments = candidate.split(/[\\/]/)
  return segments.some((segment, index) => segment === "plugins" && segments[index + 1] === "cache")
}

async function canonicalizePath(filePath: string, allowMissing: boolean): Promise<string | null> {
  try {
    return await realpath(filePath)
  } catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") return null
  }

  const missingSegments: string[] = []
  let existingAncestor = filePath

  while (true) {
    let ancestorInfo
    try {
      ancestorInfo = await lstat(existingAncestor)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null
      const parent = dirname(existingAncestor)
      if (parent === existingAncestor) return null
      missingSegments.unshift(basename(existingAncestor))
      existingAncestor = parent
      continue
    }

    // A broken symlink has an lstat result but no real path. Treat it as unsafe
    // instead of projecting the missing target through its lexical parent.
    let canonicalAncestor: string
    try {
      canonicalAncestor = await realpath(existingAncestor)
    } catch {
      return null
    }

    if (missingSegments.length > 0) {
      try {
        const canonicalInfo = ancestorInfo.isSymbolicLink()
          ? await stat(canonicalAncestor)
          : ancestorInfo
        if (!canonicalInfo.isDirectory()) return null
      } catch {
        return null
      }
    }

    return resolve(canonicalAncestor, ...missingSegments)
  }
}

/** Check the lexical shape before an asynchronous canonical filesystem check. */
export function isAllowedConfigPath(filePath: string): boolean {
  return classifyConfigPath(filePath) !== null
}

/** Check if a path is user-owned (not inside plugins/cache) */
export function isUserOwned(filePath: string): boolean {
  const policy = classifyConfigPath(filePath)
  if (!policy) return false
  if (policy.kind === "instructions-file") return true
  return !isPluginCachePath(policy.resolvedPath)
}

/**
 * Resolve an allowed config-browser path and prove that symlinks do not move it
 * outside agent configuration.
 *
 * Links are load-bearing here: shared setups point ~/.claude/skills/<name> and
 * ~/.codex/skills/<name> at one ~/.agents/skills tree, and ~/.claude/CLAUDE.md
 * at ~/AGENTS.md. A link may therefore cross into a different config root, but
 * it must still land in some config root or on an instructions file.
 */
export async function resolveConfigBrowserPath(
  filePath: string,
  options: ResolveConfigPathOptions = {},
): Promise<ConfigPathResolution | null> {
  const policy = classifyConfigPath(filePath)
  if (!policy) return null
  if (options.requireConfigDirectory && policy.kind !== "config-directory") return null
  if (
    options.writable
    && policy.kind === "config-directory"
    && isPluginCachePath(policy.resolvedPath)
  ) return null

  const [canonicalRoot, canonicalPath] = await Promise.all([
    canonicalizePath(policy.policyRoot, options.allowMissing === true),
    canonicalizePath(policy.resolvedPath, options.allowMissing === true),
  ])
  if (!canonicalRoot || !canonicalPath) return null

  if (policy.kind === "config-directory") {
    // A target outside the starting root is trusted only if it is itself inside
    // a config root, whose plugin cache must then govern writability.
    const canonicalTargetRoot = isWithin(canonicalRoot, canonicalPath)
      ? canonicalRoot
      : findConfigRoot(canonicalPath)
    if (!canonicalTargetRoot && !isInstructionsFile(canonicalPath)) return null
    if (options.writable && isPluginCachePath(canonicalPath)) return null
  } else {
    // Resolve the parent independently so a project directory may itself be a
    // symlink, while a CLAUDE.md symlink to some other file is still rejected.
    const canonicalParent = await canonicalizePath(dirname(policy.resolvedPath), false)
    if (!canonicalParent) return null
    const stayedInPlace = canonicalPath === join(canonicalParent, basename(policy.resolvedPath))
    if (!stayedInPlace && !isInstructionsFile(canonicalPath)) return null
  }

  return { resolvedPath: policy.resolvedPath, canonicalPath }
}

/** A user-supplied create/rename name must be one portable leaf component. */
export function isSafeConfigName(name: string): boolean {
  if (!name || name === "." || name === ".." || name.includes("\0")) return false
  if (name.includes("/") || name.includes("\\")) return false
  if (isAbsolute(name) || posix.parse(name).root || win32.parse(name).root) return false
  return true
}

/** Whether a directory named `dirName` appears anywhere in the path. */
function isUnderDir(parentDir: string, dirName: string): boolean {
  return parentDir.includes(`${sep}${dirName}`) || parentDir.endsWith(`/${dirName}`)
}

/** Get file type from path and context */
export function getFileType(filePath: string, parentDir: string): ConfigFileType {
  const name = basename(filePath)
  if (isInstructionsFile(name)) return "instructions"
  if (SETTINGS_FILES.has(name)) return "settings"
  // Checked before the agents directory so a skill stored under a shared
  // `.agents` tree is still typed as a skill.
  if (name === "SKILL.md") return "skill"
  if (isUnderDir(parentDir, "agents")) return "agent"
  // Codex calls its commands "prompts".
  if (isUnderDir(parentDir, "commands") || isUnderDir(parentDir, "prompts")) return "command"
  return "unknown"
}

// ── Templates for new files ────────────────────────────────────────────

export const templates: Record<string, string> = {
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
  instructions: `# Project Instructions

Add your project-specific instructions here.
`,
}
