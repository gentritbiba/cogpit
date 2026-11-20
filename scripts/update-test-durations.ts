/**
 * Rewrites build/testDurations.json, the seconds per test file that `--shard`
 * runs split the suite by (build/durationSequencer.ts). It reads the Vitest
 * JSON report you name, or by default the `test-report` artifact of the latest
 * green Quality run on master that has one, timed on the runners the shards
 * run on. Rerun it when one shard in CI takes much longer than the rest.
 *
 *   bun scripts/update-test-durations.ts [report.json]
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { TEST_DURATIONS_FILE } from "../build/durationSequencer"
import { root } from "./lib/sourceFiles"

function gh(...args: string[]): string {
  const run = Bun.spawnSync(["gh", ...args], { cwd: root, stderr: "inherit" })
  if (run.exitCode !== 0) throw new Error(`gh ${args.join(" ")} failed (exit ${run.exitCode})`)
  return run.stdout.toString().trim()
}

/** The deepest directory every path is under: the checkout the suite ran in. */
function commonDirectory(paths: string[]): string {
  const [first = "", ...rest] = paths.map((path) => path.split("/"))
  let length = first.length - 1
  for (const parts of rest) {
    let same = 0
    while (same < length && parts[same] === first[same]) same++
    length = same
  }
  return first.slice(0, length).join("/") || "/"
}

const scratch = mkdtempSync(join(tmpdir(), "cogpit-test-durations-"))
try {
  let report = process.argv[2]
  if (!report) {
    // A version-bump run reuses its parent's checks and uploads no report.
    const runIds = gh("run", "list", "--workflow", "quality.yml", "--branch", "master", "--event", "push",
      "--status", "success", "--limit", "20", "--json", "databaseId", "--jq", ".[].databaseId").split("\n")
    const runId = runIds.find((id) => id && gh("api", `repos/{owner}/{repo}/actions/runs/${id}/artifacts?name=test-report`, "--jq", ".total_count") !== "0")
    if (!runId) throw new Error("No recent green Quality run on master has a test-report to read durations from")
    gh("run", "download", runId, "--name", "test-report", "--dir", scratch)
    report = join(scratch, "test-report.json")
  }
  const { testResults } = JSON.parse(readFileSync(report, "utf8")) as {
    testResults: { name: string; startTime: number; endTime: number }[]
  }
  // The report names files by absolute path on the machine that ran them.
  const names = testResults.map(({ name }) => name.replaceAll("\\", "/"))
  const checkout = commonDirectory(names)
  const durations = Object.fromEntries(
    testResults
      .map(({ startTime, endTime }, index) => [
        relative(checkout, names[index]!).replaceAll("\\", "/"),
        Math.max(0.1, Math.round((endTime - startTime) / 100) / 10),
      ] as const)
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  )
  writeFileSync(join(root, TEST_DURATIONS_FILE), `${JSON.stringify(durations, null, 2)}\n`)
  console.log(`Wrote ${Object.keys(durations).length} durations to ${TEST_DURATIONS_FILE}`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
