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

export type ConfigFileType =
  | "command"
  | "skill"
  | "agent"
  | "claude-md"
  | "settings"
  | "unknown"
  | "theme"
  | "monitor"
  | "bin"

type ConfigPathKind = "claude-directory" | "claude-md"

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
  requireClaudeDirectory?: boolean
}

function findClaudeRoot(filePath: string): string | null {
  let current = filePath
  let claudeRoot: string | null = null
  while (true) {
    // Keep walking after a match. Anchoring to the outermost .claude boundary
    // prevents a nested `.claude` symlink from redefining the trusted root.
    if (basename(current) === ".claude") claudeRoot = current
    const parent = dirname(current)
    if (parent === current) return claudeRoot
    current = parent
  }
}

function classifyConfigPath(filePath: string): ConfigPathPolicy | null {
  if (!filePath || filePath.includes("\0")) return null

  const resolvedPath = resolve(filePath)
  const claudeRoot = findClaudeRoot(resolvedPath)
  if (claudeRoot) {
    return {
      kind: "claude-directory",
      resolvedPath,
      policyRoot: claudeRoot,
    }
  }

  // Project-root CLAUDE.md files are intentionally valid even though they sit
  // beside, rather than inside, the project's .claude directory.
  if (basename(resolvedPath) === "CLAUDE.md") {
    return {
      kind: "claude-md",
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

function isPluginCachePath(claudeRoot: string, candidate: string): boolean {
  return isWithin(join(claudeRoot, "plugins", "cache"), candidate)
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
  if (policy.kind === "claude-md") return true
  return !isPluginCachePath(policy.policyRoot, policy.resolvedPath)
}

/**
 * Resolve an allowed config-browser path and prove that symlinks do not move it
 * outside the lexical .claude root (or redirect a project-root CLAUDE.md).
 */
export async function resolveConfigBrowserPath(
  filePath: string,
  options: ResolveConfigPathOptions = {},
): Promise<ConfigPathResolution | null> {
  const policy = classifyConfigPath(filePath)
  if (!policy) return null
  if (options.requireClaudeDirectory && policy.kind !== "claude-directory") return null
  if (
    options.writable
    && policy.kind === "claude-directory"
    && isPluginCachePath(policy.policyRoot, policy.resolvedPath)
  ) return null

  const [canonicalRoot, canonicalPath] = await Promise.all([
    canonicalizePath(policy.policyRoot, options.allowMissing === true),
    canonicalizePath(policy.resolvedPath, options.allowMissing === true),
  ])
  if (!canonicalRoot || !canonicalPath) return null

  if (policy.kind === "claude-directory") {
    if (!isWithin(canonicalRoot, canonicalPath)) return null
    if (options.writable && isPluginCachePath(canonicalRoot, canonicalPath)) return null
  } else {
    // Resolve the parent independently so a project directory may itself be a
    // symlink, while a CLAUDE.md symlink to some other file is still rejected.
    const canonicalParent = await canonicalizePath(dirname(policy.resolvedPath), false)
    if (!canonicalParent || canonicalPath !== join(canonicalParent, "CLAUDE.md")) return null
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

/** Get file type from path and context */
export function getFileType(filePath: string, parentDir: string): ConfigFileType {
  const name = basename(filePath)
  if (name === "CLAUDE.md") return "claude-md"
  if (name === "settings.json" || name === "settings.local.json") return "settings"
  if (parentDir.includes(`${sep}agents`) || parentDir.endsWith("/agents")) return "agent"
  if (name === "SKILL.md") return "skill"
  if (parentDir.includes(`${sep}commands`) || parentDir.endsWith("/commands")) return "command"
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
  "claude-md": `# Project Instructions

Add your project-specific instructions here.
`,
}
