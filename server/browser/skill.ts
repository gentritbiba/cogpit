/** Cogpit browser skill delivery through the bundled plugin and global installs. */
import { existsSync } from "node:fs"
import { join } from "node:path"
import { writeIfChanged } from "./files"
import type { BrowserSkillTarget } from "../../shared/browser/types"
import { AGENT_KINDS, descriptorFor } from "../../shared/session/agent-descriptors"
import type { AgentKind } from "../../shared/session/types"
import { pluginDir } from "./paths"
import { BUNDLED_SKILLS } from "../agents/bundledSkills"
import { bundledSkillCurrent, skillConfigRoot, writeBundledSkill, writeBundledSkills } from "../agents/skills"

export const SKILL_NAME = "cogpit-browser"

export const PLUGIN_MANIFEST = {
  name: "cogpit",
  version: "1",
  description: "Cogpit's built-in skills for the agents it runs.",
}

export const COGPIT_BROWSER_SKILL = BUNDLED_SKILLS[SKILL_NAME]["SKILL.md"]

/** The plugin Cogpit writes is shaped for whichever CLI reads plugins from a path. */
function pluginManifestDirName(): string | null {
  for (const kind of AGENT_KINDS) {
    const { pluginManifestDir } = descriptorFor(kind).config
    if (pluginManifestDir !== null) return pluginManifestDir
  }
  return null
}

/** Null when no CLI takes a plugin, in which case only the skill install reaches agents. */
export function pluginManifestFile(): string | null {
  const dir = pluginManifestDirName()
  return dir === null ? null : join(pluginDir(), dir, "plugin.json")
}

export function pluginSkillFile(): string {
  return join(pluginDir(), "skills", SKILL_NAME, "SKILL.md")
}

/** Materialises the plugin agents load from disk. Idempotent. */
export function ensurePlugin(): string | null {
  const manifest = pluginManifestFile()
  if (manifest === null) return null
  writeIfChanged(manifest, `${JSON.stringify(PLUGIN_MANIFEST, null, 2)}\n`)
  writeBundledSkills(join(pluginDir(), "skills"))
  return pluginDir()
}

const configRoot = skillConfigRoot

function skillDir(kind: AgentKind): string | null {
  const { skillsDir } = descriptorFor(kind).config
  return skillsDir === null ? null : join(configRoot(kind), skillsDir, SKILL_NAME)
}

/** Copies the skill into a CLI's global config, for agents Cogpit does not spawn. */
export function installSkill(target: AgentKind): string {
  const dir = skillDir(target)
  if (dir === null) throw new Error(`${descriptorFor(target).displayName} has no skills directory`)
  writeBundledSkill(dir, SKILL_NAME)
  return dir
}

/**
 * What the panel lists: every CLI that reads skills, with the directory an
 * install would write into and whether the skill is already there.
 */
export function skillTargets(): BrowserSkillTarget[] {
  const pluginDirName = pluginManifestDirName()
  return AGENT_KINDS.flatMap((kind) => {
    const dir = skillDir(kind)
    if (dir === null) return []
    const { config, displayName } = descriptorFor(kind)
    return [{
      kind,
      label: displayName,
      configRoot: configRoot(kind),
      installed: bundledSkillCurrent(dir, SKILL_NAME),
      automatic: existsSync(configRoot(kind)) || (config.pluginManifestDir !== null && config.pluginManifestDir === pluginDirName),
    }]
  })
}

/**
 * Installs for every CLI at once, for the user who asks for all of them.
 *
 * Skips a CLI whose config root is absent rather than creating one the user
 * never asked for, and one CLI failing never costs the rest theirs.
 */
export function installSkillEverywhere(): string[] {
  const installed: string[] = []
  const failures: string[] = []
  for (const kind of AGENT_KINDS) {
    const dir = skillDir(kind)
    if (dir === null || !existsSync(configRoot(kind))) continue
    try {
      writeBundledSkill(dir, SKILL_NAME)
      installed.push(dir)
    } catch (error) {
      failures.push(`${dir}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (failures.length > 0) throw new Error(`The browser skill did not reach ${failures.join("; ")}`)
  return installed
}
