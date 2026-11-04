import { createHash } from "node:crypto"
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmdirSync, rmSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { BrowserSkillTarget } from "../../shared/browser/types"
import { AGENT_KINDS, descriptorFor, type AgentKind } from "../../shared/session/agent-descriptors"
import { agentHomeDir } from "../config"
import { hasContent, writeIfChanged } from "../browser/files"
import { COGPIT_SKILL_FILES } from "./bundledSkills"
import { RETIRED_SKILL_DIRS, RETIRED_SKILL_FILES } from "./retiredSkillFiles"

export const COGPIT_SKILL = "cogpit"

/** The configured home first, then the one an SDK session inherits from the environment when that differs. */
function configRoots(kind: AgentKind): string[] {
  const { cli, config } = descriptorFor(kind)
  const override = process.env.COGPIT_SKILL_HOME
  if (override) return [join(override, config.rootDirName)]
  if (!cli.sdkHomeEnvVar) return [agentHomeDir(kind)]
  const sdkHome = resolve(process.env[cli.sdkHomeEnvVar] || join(homedir(), cli.homeDirName))
  return [...new Set([agentHomeDir(kind), sdkHome])]
}

export function skillConfigRoot(kind: AgentKind): string {
  return configRoots(kind)[0]
}

function skillsDir(kind: AgentKind): string | null {
  const { skillsDir } = descriptorFor(kind).config
  return skillsDir === null ? null : join(skillConfigRoot(kind), skillsDir)
}

function writeSkill(directory: string): void {
  for (const [file, content] of Object.entries(COGPIT_SKILL_FILES)) {
    const path = join(directory, file)
    writeIfChanged(existsSync(path) ? realpathSync(path) : path, content)
  }
}

function skillCurrent(directory: string): boolean {
  return Object.entries(COGPIT_SKILL_FILES).every(([file, content]) => hasContent(join(directory, file), content))
}

function attempt(what: string, run: () => void): boolean {
  try {
    run()
    return true
  } catch (error) {
    console.error(`Cogpit skill: could not ${what}.`, error)
    return false
  }
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

/**
 * Removes files an older release installed, only where they are unmodified and
 * not reached through a link, and records each directory that empties.
 */
function retireOldFiles(skills: string, removed: Set<string>): void {
  for (const [file, hashes] of Object.entries(RETIRED_SKILL_FILES)) {
    const path = join(skills, file)
    attempt(`remove ${path}`, () => {
      if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) return
      if (realpathSync(path) !== join(realpathSync(skills), file)) return
      if (hashes.includes(sha256(path))) rmSync(path)
    })
  }
  for (const dir of RETIRED_SKILL_DIRS) {
    const path = join(skills, dir)
    attempt(`remove ${path}`, () => {
      if (!lstatSync(path, { throwIfNoEntry: false })?.isDirectory() || readdirSync(path).length > 0) return
      const real = realpathSync(path)
      rmdirSync(path)
      removed.add(path).add(real)
    })
  }
}

/** Runs once every CLI's old copies are gone: a link into one of them, as `~/.codex/skills/x -> ~/.claude/skills/x`, now dangles. */
function unlinkLinksToRemoved(skills: string, removed: ReadonlySet<string>): void {
  for (const dir of RETIRED_SKILL_DIRS) {
    const path = join(skills, dir)
    attempt(`remove ${path}`, () => {
      if (!lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) return
      if (removed.has(resolve(dirname(path), readlinkSync(path)))) unlinkSync(path)
    })
  }
}

/**
 * Startup refresh into every existing agent config root; a CLI the user does
 * not have is skipped rather than created. One failure never costs the others.
 */
export function installCogpitSkill(kinds: readonly AgentKind[] = AGENT_KINDS): { installed: string[]; failed: string[] } {
  const skillDirs = kinds.flatMap((kind) => {
    const { skillsDir } = descriptorFor(kind).config
    if (skillsDir === null) return []
    return configRoots(kind).filter((root) => existsSync(root)).map((root) => join(root, skillsDir))
  })
  const removed = new Set<string>()
  for (const skills of skillDirs) retireOldFiles(skills, removed)
  for (const skills of skillDirs) unlinkLinksToRemoved(skills, removed)
  const installed: string[] = []
  const failed: string[] = []
  for (const skills of skillDirs) {
    const directory = join(skills, COGPIT_SKILL)
    if (attempt(`refresh ${directory}`, () => writeSkill(directory))) installed.push(directory)
    else failed.push(directory)
  }
  return { installed, failed }
}

/** Installs for one CLI, creating its config root: the user asked for this one. */
export function installSkill(target: AgentKind): string {
  const skills = skillsDir(target)
  if (skills === null) throw new Error(`${descriptorFor(target).displayName} has no skills directory`)
  const directory = join(skills, COGPIT_SKILL)
  writeSkill(directory)
  return directory
}

export function installSkillEverywhere(): string[] {
  const { installed, failed } = installCogpitSkill()
  if (failed.length > 0) throw new Error(`The Cogpit skill did not reach ${failed.join(", ")}`)
  return installed
}

/** Every CLI that reads skills, where an install would write, and whether it is current there. */
export function skillTargets(): BrowserSkillTarget[] {
  return AGENT_KINDS.flatMap((kind) => {
    const skills = skillsDir(kind)
    if (skills === null) return []
    const configRoot = skillConfigRoot(kind)
    return [{
      kind,
      label: descriptorFor(kind).displayName,
      configRoot,
      installed: skillCurrent(join(skills, COGPIT_SKILL)),
      automatic: existsSync(configRoot),
    }]
  })
}
