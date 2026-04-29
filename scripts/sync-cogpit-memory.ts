#!/usr/bin/env bun
/**
 * Sync shared modules from src/lib/ to packages/cogpit-memory/src/lib/.
 * cogpit (agent-window) is the source of truth for these files.
 */
import { copyFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")
const SRC = join(ROOT, "src/lib")
const DEST = join(ROOT, "packages/cogpit-memory/src/lib")

const FILES = [
  "parser.ts",
  "codex.ts",
  "turnBuilder.ts",
  "types.ts",
  "sessionStats.ts",
  "sessionStatus.ts",
  "token-costs.ts",
  "pricingTiers.ts",
  "costAnalytics.ts",
  "interactiveState.ts",
]

mkdirSync(DEST, { recursive: true })

for (const file of FILES) {
  copyFileSync(join(SRC, file), join(DEST, file))
  console.log(`  synced ${file}`)
}

console.log(`\nSynced ${FILES.length} files to packages/cogpit-memory/src/lib/`)
