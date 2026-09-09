import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

function findSkillContent(): string {
  const candidates: string[] = []

  if (typeof __dirname !== "undefined") {
    candidates.push(join(__dirname, "..", "skill", "SKILL.md"))   // from dist/
    candidates.push(join(__dirname, "..", "..", "skill", "SKILL.md")) // from src/commands/
  }

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        return readFileSync(candidate, "utf-8")
      }
    } catch {
      // Try the next candidate when this path is unreadable.
    }
  }

  throw new Error("Could not find SKILL.md — try reinstalling cogpit-memory")
}

export function installSkill(cwd?: string, global?: boolean): { installed: boolean; path: string } {
  const root = global
    ? join(process.env.HOME ?? process.env.USERPROFILE ?? "~", ".claude")
    : join(cwd ?? process.cwd(), ".claude")
  const skillDir = join(root, "skills", "cogpit-memory")

  mkdirSync(skillDir, { recursive: true })

  const content = findSkillContent()
  const dest = join(skillDir, "SKILL.md")
  writeFileSync(dest, content)

  return { installed: true, path: skillDir }
}
