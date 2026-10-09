import { existsSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { AGENT_KINDS, descriptorFor, type AgentKind } from "../../shared/session/agent-descriptors"
import { agentHomeDir } from "../config"
import { hasContent, writeIfChanged } from "../browser/files"
import { BUNDLED_SKILLS } from "./bundledSkills"

export function skillConfigRoot(kind: AgentKind): string {
  const override = process.env.COGPIT_SKILL_HOME
  return override ? join(override, descriptorFor(kind).config.rootDirName) : agentHomeDir(kind)
}

export function writeBundledSkill(directory: string, name: string): void {
  for (const [file, content] of Object.entries(BUNDLED_SKILLS[name])) {
    const path = join(directory, file)
    writeIfChanged(existsSync(path) ? realpathSync(path) : path, content)
  }
}

export function bundledSkillCurrent(directory: string, name: string): boolean {
  return Object.entries(BUNDLED_SKILLS[name]).every(([file, content]) => hasContent(join(directory, file), content))
}

export function writeBundledSkills(directory: string): void {
  for (const name of Object.keys(BUNDLED_SKILLS)) writeBundledSkill(join(directory, name), name)
}

/** Startup refresh is best-effort; one unwritable skill must not block other agents. */
export function installBundledSkills(kinds: readonly AgentKind[] = AGENT_KINDS): string[] {
  const installed: string[] = []
  for (const kind of kinds) {
    const { skillsDir } = descriptorFor(kind).config
    const root = skillConfigRoot(kind)
    if (skillsDir === null || !existsSync(root)) continue
    for (const name of Object.keys(BUNDLED_SKILLS)) {
      const directory = join(root, skillsDir, name)
      try {
        writeBundledSkill(directory, name)
        installed.push(directory)
      } catch (error) {
        console.error(`Cogpit skills: could not refresh ${directory}.`, error)
      }
    }
  }
  return installed
}
