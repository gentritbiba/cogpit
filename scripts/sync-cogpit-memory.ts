#!/usr/bin/env bun
/**
 * Sync the canonical session core from shared/session/ to cogpit-memory.
 * Neutral shared modules are the source of truth; package copies are generated.
 *
 * Pass --check in CI to fail when a generated copy has drifted.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")
const SRC = join(ROOT, "shared/session")
const DEST = join(ROOT, "packages/cogpit-memory/src/lib")

const FILES = [
  "parser.ts",
  "codex.ts",
  "codex-patches.ts",
  "codex-tool-normalization.ts",
  "turnBuilder.ts",
  "types.ts",
  "messageTypeGuards.ts",
  "sessionStats.ts",
  "sessionStatus.ts",
  "token-costs.ts",
  "pricingTiers.ts",
  "interactiveState.ts",
] as const

const governedFiles = new Set<string>(FILES)
const unmanagedDependencies: string[] = []
for (const file of FILES) {
  const source = readFileSync(join(SRC, file), "utf8")
  for (const match of source.matchAll(/\bfrom\s+["']\.\/([^"']+)["']/g)) {
    const dependency = `${match[1].replace(/\.(?:js|ts)$/, "")}.ts`
    if (existsSync(join(SRC, dependency)) && !governedFiles.has(dependency)) {
      unmanagedDependencies.push(`${file} -> ${dependency}`)
    }
  }
}

if (unmanagedDependencies.length > 0) {
  console.error("The cogpit-memory shared-module dependency closure is incomplete:")
  for (const dependency of unmanagedDependencies) console.error(`  - ${dependency}`)
  process.exit(1)
}

const checkOnly = process.argv.slice(2).includes("--check")
const driftedFiles = FILES.filter((file) => {
  try {
    return !readFileSync(join(SRC, file)).equals(readFileSync(join(DEST, file)))
  } catch {
    return true
  }
})

if (checkOnly) {
  if (driftedFiles.length > 0) {
    console.error("cogpit-memory shared modules are out of sync:")
    for (const file of driftedFiles) console.error(`  - ${file}`)
    console.error("Run `bun run sync-cogpit-memory` and commit the generated copies.")
    process.exit(1)
  }

  console.log(`Verified ${FILES.length} cogpit-memory shared modules`)
  process.exit(0)
}

mkdirSync(DEST, { recursive: true })

for (const file of FILES) {
  copyFileSync(join(SRC, file), join(DEST, file))
  console.log(`  synced ${file}`)
}

console.log(`\nSynced ${FILES.length} files to packages/cogpit-memory/src/lib/`)
