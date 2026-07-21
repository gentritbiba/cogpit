import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

interface DuplicateReport {
  statistics: {
    total: {
      clones: number
      duplicatedLines: number
      percentage: number
    }
  }
}

// Absolute ratchets complement jscpd's percentage threshold. Growth in the
// codebase can no longer hide newly copied blocks behind a stable percentage.
const MAX_CLONES = 80
const MAX_DUPLICATED_LINES = 728

const outputDir = await mkdtemp(join(tmpdir(), "cogpit-jscpd-"))
try {
  const result = Bun.spawnSync([
    "bunx",
    "jscpd",
    "--config",
    ".jscpd.json",
    "--reporters",
    "console,json",
    "--output",
    outputDir,
  ], {
    stdout: "inherit",
    stderr: "inherit",
  })

  const report = await Bun.file(join(outputDir, "jscpd-report.json")).json() as DuplicateReport
  const total = report.statistics.total
  const violations: string[] = []
  if (total.clones > MAX_CLONES) {
    violations.push(`clone count ${total.clones} exceeds ratchet ${MAX_CLONES}`)
  }
  if (total.duplicatedLines > MAX_DUPLICATED_LINES) {
    violations.push(
      `duplicated lines ${total.duplicatedLines} exceed ratchet ${MAX_DUPLICATED_LINES}`,
    )
  }

  if (result.exitCode !== 0 || violations.length > 0) {
    for (const violation of violations) console.error(`- ${violation}`)
    process.exitCode = 1
  } else {
    console.log(
      `Duplicate ratchet passed: ${total.clones}/${MAX_CLONES} clones, `
      + `${total.duplicatedLines}/${MAX_DUPLICATED_LINES} duplicated lines, `
      + `${total.percentage.toFixed(2)}%.`,
    )
  }
} finally {
  await rm(outputDir, { recursive: true, force: true })
}
