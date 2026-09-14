#!/usr/bin/env bun
/**
 * The `cogpit` skill bundles the standalone cogpit-sessions and cogpit-memory
 * skills as reference files, so `npx skills add` installs all three as one unit.
 * The standalone skills stay the sources of truth; this script copies their
 * bodies into .claude/skills/cogpit/references/.
 *
 * Pass --check in CI to fail when a generated copy has drifted.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")
const DEST = join(ROOT, ".claude/skills/cogpit/references")

const SOURCES = [
  { from: ".claude/skills/cogpit-sessions/SKILL.md", to: "cogpit-sessions.md" },
  { from: "packages/cogpit-memory/skill/SKILL.md", to: "cogpit-memory.md" },
] as const

function render(from: string): string {
  const body = readFileSync(join(ROOT, from), "utf8").replace(/^---\n[\s\S]*?\n---\n+/, "")
  return `<!-- Generated from ${from} by scripts/sync-cogpit-skill.ts. Edit the source, then run \`bun run sync-cogpit-skill\`. -->\n\n${body}`
}

const checkOnly = process.argv.slice(2).includes("--check")
const rendered = SOURCES.map((source) => ({ ...source, content: render(source.from) }))

if (checkOnly) {
  const drifted = rendered.filter(({ to, content }) => {
    try {
      return readFileSync(join(DEST, to), "utf8") !== content
    } catch {
      return true
    }
  })
  if (drifted.length > 0) {
    console.error("The cogpit skill references are out of sync:")
    for (const { to } of drifted) console.error(`  - ${to}`)
    console.error("Run `bun run sync-cogpit-skill` and commit the generated copies.")
    process.exit(1)
  }
  console.log(`Verified ${rendered.length} cogpit skill references`)
  process.exit(0)
}

mkdirSync(DEST, { recursive: true })
for (const { to, content } of rendered) {
  writeFileSync(join(DEST, to), content)
  console.log(`  synced ${to}`)
}
