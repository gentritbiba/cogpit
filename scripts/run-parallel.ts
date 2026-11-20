/**
 * Runs package scripts at the same time and prints each one's output whole
 * when it ends, so their logs never interleave. Each argument is what follows
 * `bun run`, optionally led by environment assignments:
 *
 *   bun scripts/run-parallel.ts lint typecheck:app "--cwd packages/cogpit-cli test"
 *   bun scripts/run-parallel.ts "COGPIT_WITHOUT_TEAM=1 build:web --outDir /tmp/public"
 *
 * Runs as many at once as the machine has cores (COGPIT_PARALLEL_JOBS
 * overrides). Exits non-zero when any script failed, after all have ended.
 */
import { availableParallelism } from "node:os"

const scripts = process.argv.slice(2)
if (scripts.length === 0) {
  console.error("usage: bun scripts/run-parallel.ts <package script>...")
  process.exit(2)
}

const limit = Math.max(1, Number(process.env.COGPIT_PARALLEL_JOBS) || availableParallelism())
const inActions = process.env.GITHUB_ACTIONS === "true"

interface Outcome {
  script: string
  ok: boolean
  seconds: string
}

async function collect(stream: ReadableStream<Uint8Array>, into: Uint8Array[]): Promise<void> {
  for await (const chunk of stream) into.push(chunk)
}

function parse(script: string): { args: string[]; env: Record<string, string> } {
  const words = script.trim().split(/\s+/)
  const env: Record<string, string> = {}
  while (words.length > 1 && /^[A-Z_][A-Z0-9_]*=/.test(words[0]!)) {
    const [name, ...value] = words.shift()!.split("=")
    env[name!] = value.join("=")
  }
  return { args: words, env }
}

async function run(script: string): Promise<Outcome> {
  const started = performance.now()
  const { args, env } = parse(script)
  const child = Bun.spawn(["bun", "run", ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const output: Uint8Array[] = []
  await Promise.all([collect(child.stdout, output), collect(child.stderr, output)])
  const ok = (await child.exited) === 0
  const seconds = ((performance.now() - started) / 1000).toFixed(1)
  const title = `${ok ? "✓" : "✗"} ${script} (${seconds}s)`
  // A failure stays outside a collapsed group so its errors show without a click.
  const grouped = inActions && ok
  process.stdout.write(grouped ? `::group::${title}\n` : `\n── ${title}\n`)
  for (const chunk of output) process.stdout.write(chunk)
  if (grouped) process.stdout.write("::endgroup::\n")
  return { script, ok, seconds }
}

const queue = [...scripts]
const outcomes: Outcome[] = []
await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
  for (let script = queue.shift(); script; script = queue.shift()) outcomes.push(await run(script))
}))

const failed = outcomes.filter((outcome) => !outcome.ok)
if (failed.length > 0) {
  console.error(`\n${failed.length} of ${scripts.length} failed: ${failed.map((outcome) => outcome.script).join(", ")}`)
  process.exit(1)
}
