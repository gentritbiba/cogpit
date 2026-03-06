import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

function findSkillContent(): string {
  // Try multiple resolution strategies to find SKILL.md

  // 1. Relative to this source file (works in Bun source mode)
  const candidates: string[] = []

  // CJS: __dirname is available
  if (typeof __dirname !== "undefined") {
    candidates.push(join(__dirname, "..", "skill", "SKILL.md"))   // from dist/
    candidates.push(join(__dirname, "..", "..", "skill", "SKILL.md")) // from src/commands/
  }

  // ESM: import.meta.url
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url))
    candidates.push(join(thisDir, "..", "skill", "SKILL.md"))
    candidates.push(join(thisDir, "..", "..", "skill", "SKILL.md"))
  } catch {}

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        return readFileSync(candidate, "utf-8")
      }
    } catch {}
  }

  throw new Error("Could not find SKILL.md — try reinstalling cogpit-memory")
}

export function installSkill(cwd?: string): { installed: boolean; path: string } {
  const root = cwd ?? process.cwd()
  const skillDir = join(root, ".claude", "skills", "cogpit-memory")

  mkdirSync(skillDir, { recursive: true })

  const content = findSkillContent()
  const dest = join(skillDir, "SKILL.md")
  writeFileSync(dest, content)

  return { installed: true, path: skillDir }
}
