/**
 * Agent-vocabulary containment check.
 *
 * Cogpit drives three agent CLIs (Claude Code, Codex, GitHub Copilot CLI). The
 * architecture rule is that only the agent modules may know which one is in
 * play; everything else goes through `AgentDescriptor` / `AgentFormat` /
 * `AgentStore` / `AgentRuntime`. Adding GitHub Copilot cost 210 files and
 * +12,769 lines precisely because that rule was not mechanically enforced.
 *
 * This check enforces it two ways:
 *
 *   1. Files inside the OWNED zone may name an agent freely — that is their job.
 *   2. Every other production file carries a budget in agent-vocabulary.json.
 *      Going over fails. Coming in UNDER also fails, with the new number, so the
 *      budget can only ever be lowered. That ratchet is what stops the vocabulary
 *      leaking back once a domain has been cleaned up.
 *
 * Detection is a case-insensitive substring, deliberately. A word-boundary
 * regex looks tidier but misses `codexAppServer`, `isCodexDirName`,
 * `parseCodexSession` and `CopilotRuntime` — i.e. most of the real call sites.
 * Comments count too: prose naming a CLI is exactly how the knowledge leaks
 * back in.
 */
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { collectSourceRoots, relativePath, root } from "./lib/sourceFiles"

const sourceRoots = ["shared", "src", "server", "electron", "packages/cogpit-memory/src"] as const
const budgetFile = join(root, "scripts/agent-vocabulary.json")

const AGENT_WORDS = ["claude", "codex", "copilot"] as const

/**
 * Files allowed to name an agent. These ARE the agent layer: the descriptor
 * table, the three transcript formats, the stores, the runtimes, and the
 * registries that bind them.
 */
const OWNED_PATTERNS: readonly RegExp[] = [
  // Pure transcript formats + descriptor table (synced into cogpit-memory).
  /^shared\/session\/(claude|codex|copilot)\.ts$/,
  /^shared\/session\/codex-[a-z-]+\.ts$/,
  /^shared\/session\/agents\.ts$/,
  /^shared\/session\/agent-descriptors\.ts$/,
  // The vocabulary itself: AgentKind and the detection order live here.
  /^shared\/session\/types\.ts$/,
  // The generated cogpit-memory copies of exactly the above.
  /^packages\/cogpit-memory\/src\/lib\/(claude|codex|copilot)\.ts$/,
  /^packages\/cogpit-memory\/src\/lib\/codex-[a-z-]+\.ts$/,
  /^packages\/cogpit-memory\/src\/lib\/agents\.ts$/,
  /^packages\/cogpit-memory\/src\/lib\/agent-descriptors\.ts$/,
  /^packages\/cogpit-memory\/src\/lib\/types\.ts$/,
  // That package's own `node:fs` walkers — the store layer it cannot import
  // from `server/`, because `packages/` may only import `packages/`.
  /^packages\/cogpit-memory\/src\/lib\/stores\.ts$/,
  // Server-side stores, runtimes and the transports they drive: one directory.
  /^server\/agents\//,
  // Endpoints that exist only to expose one CLI's own protocol. They are the
  // agent layer reaching the network, not product code branching on an agent.
  /^server\/routes\/codex-threads\.ts$/,
  /^server\/routes\/copilot-history\.ts$/,
  // Renderer-side agent presentation (icons are React and cannot live in shared/).
  /^src\/lib\/agents\//,
]

interface Budgets {
  /** Documentation for whoever opens this file after a failing build. */
  readonly $comment?: string | readonly string[]
  readonly files: Record<string, number>
}

function isOwned(path: string): boolean {
  return OWNED_PATTERNS.some((pattern) => pattern.test(path))
}

/** Number of lines in `source` that name an agent. */
function countAgentLines(source: string): number {
  let count = 0
  for (const line of source.split("\n")) {
    const lowered = line.toLowerCase()
    if (AGENT_WORDS.some((word) => lowered.includes(word))) count += 1
  }
  return count
}

const paths = await collectSourceRoots(sourceRoots)

const observed = new Map<string, number>()
for (const path of paths) {
  const key = relativePath(path)
  if (isOwned(key)) continue
  const count = countAgentLines(await readFile(path, "utf8"))
  if (count > 0) observed.set(key, count)
}

const writeMode = process.argv.slice(2).includes("--write")

if (writeMode) {
  const files = Object.fromEntries([...observed].sort(([a], [b]) => a.localeCompare(b)))
  const total = [...observed.values()].reduce((sum, n) => sum + n, 0)
  const payload: Budgets = {
    $comment: [
      "Per-file budget of lines naming an agent CLI, outside the agent layer.",
      "These numbers may only go DOWN. check-agents.ts fails if a file exceeds",
      "its budget, and also if it comes in under — so a cleanup must lower the",
      "number in the same commit. Delete the entry once a file reaches zero.",
      `Seeded at ${observed.size} files / ${total} lines.`,
    ],
    files,
  }
  await writeFile(budgetFile, `${JSON.stringify(payload, null, 2)}\n`)
  console.log(`Wrote ${budgetFile}: ${observed.size} files, ${total} lines.`)
  process.exit(0)
}

let budgets: Budgets
try {
  budgets = JSON.parse(await readFile(budgetFile, "utf8")) as Budgets
} catch {
  console.error(`Missing ${relativePath(budgetFile)}. Seed it with: bun scripts/check-agents.ts --write`)
  process.exit(1)
}

const violations: string[] = []

for (const [path, count] of [...observed].sort(([a], [b]) => a.localeCompare(b))) {
  const budget = budgets.files[path]
  if (budget === undefined) {
    violations.push(
      `${path}: names an agent CLI on ${count} line(s) but has no budget. `
      + `Route it through AgentDescriptor/AgentFormat/AgentStore/AgentRuntime, `
      + `or add it to the agent layer in check-agents.ts OWNED_PATTERNS.`,
    )
  } else if (count > budget) {
    violations.push(`${path}: ${count} agent-naming lines exceeds its budget of ${budget}.`)
  } else if (count < budget) {
    violations.push(`${path}: down to ${count} agent-naming lines — lower its budget from ${budget} to ${count}.`)
  }
}

for (const path of Object.keys(budgets.files)) {
  if (!observed.has(path)) {
    violations.push(`${path}: no longer names an agent CLI — remove its entry from ${relativePath(budgetFile)}.`)
  }
}

const total = [...observed.values()].reduce((sum, n) => sum + n, 0)
const budgeted = Object.values(budgets.files).reduce((sum, n) => sum + n, 0)

if (violations.length > 0) {
  console.error("Agent-vocabulary check failed:\n")
  for (const violation of violations) console.error(`- ${violation}`)
  console.error(`\n${observed.size} files / ${total} lines outside the agent layer (budgeted: ${budgeted}).`)
  process.exitCode = 1
} else {
  console.log(
    `Agent-vocabulary check passed: ${observed.size} files / ${total} lines outside the agent layer, `
    + `all within budget.`,
  )
}
