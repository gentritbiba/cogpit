import { resolve, sep, basename } from "node:path"
import type { ConfigTreeItem } from "./configTree"

/** Check if a path is an allowed config file (inside .claude/ or a CLAUDE.md beside it) */
export function isAllowedConfigPath(filePath: string): boolean {
  const resolved = resolve(filePath)
  const claudeSegment = `${sep}.claude${sep}`
  if (resolved.includes(claudeSegment) || resolved.endsWith(`${sep}.claude`)) return true
  // Allow project-root CLAUDE.md (sibling of .claude directory)
  if (basename(resolved) === "CLAUDE.md") return true
  return false
}

/** Check if a path is user-owned (not inside plugins/cache) */
export function isUserOwned(filePath: string): boolean {
  const resolved = resolve(filePath)
  if (basename(resolved) === "CLAUDE.md") return true
  return isAllowedConfigPath(resolved) && !resolved.includes(`${sep}plugins${sep}cache${sep}`)
}

/** Get file type from path and context */
export function getFileType(filePath: string, parentDir: string): ConfigTreeItem["fileType"] {
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
