/**
 * Rewrites build/testDurations.json, the seconds per test file that `--shard`
 * runs split the suite by (build/durationSequencer.ts). It reads the Vitest
 * JSON report you name, or by default the `test-report` artifact of the latest
 * green Quality run on master, timed on the runners the shards run on. Rerun
 * it when one shard in CI takes much longer than the rest.
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

const scratch = mkdtempSync(join(tmpdir(), "cogpit-test-durations-"))
try {
  let report = process.argv[2]
  if (!report) {
    const runId = gh("run", "list", "--workflow", "quality.yml", "--branch", "master", "--event", "push",
      "--status", "success", "--limit", "1", "--json", "databaseId", "--jq", ".[0].databaseId")
    if (!runId) throw new Error("No green Quality run on master to read durations from")
    gh("run", "download", runId, "--name", "test-report", "--dir", scratch)
    report = join(scratch, "test-report.json")
  }
  const { testResults } = JSON.parse(readFileSync(report, "utf8")) as {
    testResults: { name: string; startTime: number; endTime: number }[]
  }
  const durations = Object.fromEntries(
    testResults
      .map(({ name, startTime, endTime }) => [
        relative(root, name).replaceAll("\\", "/"),
        Math.max(0.1, Math.round((endTime - startTime) / 100) / 10),
      ] as const)
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  )
  writeFileSync(join(root, TEST_DURATIONS_FILE), `${JSON.stringify(durations, null, 2)}\n`)
  console.log(`Wrote ${Object.keys(durations).length} durations to ${TEST_DURATIONS_FILE}`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
