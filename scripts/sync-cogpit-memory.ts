#!/usr/bin/env bun
/**
 * Sync the canonical shared modules into cogpit-memory: the session core from
 * shared/session/ and the memory store from shared/memory/. Neutral shared
 * modules are the source of truth; package copies are generated.
 *
 * The session core lands flat in src/lib/, so a memory module's
 * `../session/x` import becomes `../x` in its copy. That rewrite is the only
 * difference between a source and its copy.
 *
 * Pass --check in CI to fail when a generated copy has drifted.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const ROOT = join(import.meta.dir, "..")

interface SyncSet {
  src: string
  dest: string
  // Deliberately explicit, never directory auto-discovery: a glob would sweep
  // __tests__ files into the published npm package.
  files: readonly string[]
  /** Sibling sets this set imports through `../<dir>/`, keyed by that dir. */
  imports?: Record<string, SyncSet>
  rewrite?: (source: string) => string
}

const SESSION: SyncSet = {
  src: "shared/session",
  dest: "packages/cogpit-memory/src/lib",
  files: [
    "parser.ts",
    "agents.ts",
    "agent-descriptors.ts",
    "agentFailures.ts",
    "claude.ts",
    "codex.ts",
    "copilot.ts",
    "codex-patches.ts",
    "codex-exec.ts",
    "codex-tool-normalization.ts",
    "turnBuilder.ts",
    "agentEnvelope.ts",
    "automatedPrompts.ts",
    "asyncAnswers.ts",
    "types.ts",
    "instances.ts",
    "messageTypeGuards.ts",
    "sessionStats.ts",
    "turnContent.ts",
    "toolResults.ts",
    "resultProjection.ts",
    "pageCuts.ts",
    "codex-results.ts",
    "composerContext.ts",
    "sessionStatus.ts",
    "backgroundAgents.ts",
    "interactiveState.ts",
  ],
}

const MEMORY: SyncSet = {
  src: "shared/memory",
  dest: "packages/cogpit-memory/src/lib/memory",
  files: [
    "chunker.ts",
    "database.ts",
    "fusion.ts",
    "hash.ts",
    "keywordSearch.ts",
    "paths.ts",
    "reconcile.ts",
    "schema.ts",
    "search.ts",
    "store.ts",
    "types.ts",
  ],
  imports: { session: SESSION },
  rewrite: (source) => source.replace(/(\bfrom\s+["'])\.\.\/session\//g, "$1../"),
}

const SETS = [SESSION, MEMORY]

function moduleFile(specifier: string): string {
  return `${specifier.replace(/\.(?:js|ts)$/, "")}.ts`
}

const unmanagedDependencies: string[] = []
for (const set of SETS) {
  for (const file of set.files) {
    const source = readFileSync(join(ROOT, set.src, file), "utf8")
    for (const match of source.matchAll(/\bfrom\s+["']\.\.?\/([^"']+)["']/g)) {
      const specifier = match[0].includes("../") ? match[1] : `./${match[1]}`
      const [, dir, rest] = /^(?:\.\/|([^/]+)\/)(.+)$/.exec(specifier) ?? []
      const owner = dir ? set.imports?.[dir] : set
      const dependency = moduleFile(rest ?? specifier)
      if (!owner) {
        unmanagedDependencies.push(`${set.src}/${file} -> ../${specifier} (no synced set for ../${dir}/)`)
      } else if (existsSync(join(ROOT, owner.src, dependency)) && !owner.files.includes(dependency)) {
        unmanagedDependencies.push(`${set.src}/${file} -> ${owner.src}/${dependency}`)
      }
    }
  }
}

if (unmanagedDependencies.length > 0) {
  console.error("The cogpit-memory shared-module dependency closure is incomplete:")
  for (const dependency of unmanagedDependencies) console.error(`  - ${dependency}`)
  process.exit(1)
}

const copies = SETS.flatMap((set) => set.files.map((file) => {
  const source = readFileSync(join(ROOT, set.src, file), "utf8")
  return { label: `${set.src}/${file}`, dest: join(ROOT, set.dest, file), content: set.rewrite ? set.rewrite(source) : source }
}))

const checkOnly = process.argv.slice(2).includes("--check")
if (checkOnly) {
  const drifted = copies.filter((copy) => {
    try {
      return readFileSync(copy.dest, "utf8") !== copy.content
    } catch {
      return true
    }
  })
  if (drifted.length > 0) {
    console.error("cogpit-memory shared modules are out of sync:")
    for (const copy of drifted) console.error(`  - ${copy.label}`)
    console.error("Run `bun run sync-cogpit-memory` and commit the generated copies.")
    process.exit(1)
  }
  console.log(`Verified ${copies.length} cogpit-memory shared modules`)
  process.exit(0)
}

for (const copy of copies) {
  mkdirSync(dirname(copy.dest), { recursive: true })
  writeFileSync(copy.dest, copy.content)
  console.log(`  synced ${copy.label}`)
}

console.log(`\nSynced ${copies.length} files into packages/cogpit-memory/src/lib/`)
