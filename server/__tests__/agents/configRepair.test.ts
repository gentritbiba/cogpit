// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { describeInvalidConfig, restoreReportedConfig } from "../../agents/configRepair"

/** The start failure Claude Code 2.1.326 wrote for an invalid global config file, paths swapped for the test's. */
function startupFailure(configDir: string, backupPath?: string) {
  const path = join(configDir, ".claude.json")
  return {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    num_turns: 0,
    errors: [`Configuration error in ${path}: JSON Parse error: Property name must be a string literal\nA backup file exists at: ${backupPath}\nYou can manually restore it by running: cp -f "${backupPath}" "${path}"`],
    startup_failure_reason: "config_file_invalid",
    invalid_config_file: { path, is_global: true, backup_searched: true, ...(backupPath ? { backup_path: backupPath } : {}) },
  }
}

describe("a start refused over an invalid config file", () => {
  let configDir: string
  let backups: string
  const previous = process.env.CLAUDE_CONFIG_DIR

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "config-repair-"))
    backups = join(configDir, "backups")
    mkdirSync(backups)
    process.env.CLAUDE_CONFIG_DIR = configDir
    writeFileSync(join(configDir, ".claude.json"), '{"numStartups": 3,')
  })

  afterEach(() => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    rmSync(configDir, { recursive: true, force: true })
  })

  it("names the file and its backup ahead of the CLI's own words", () => {
    const backup = join(backups, ".claude.json.backup.1763400000000")
    const result = startupFailure(configDir, backup)
    const message = describeInvalidConfig(result, result.errors[0])

    expect(message?.split("\n").slice(0, 3)).toEqual([
      "Claude Code can't start: a config file isn't valid JSON.",
      `File: ${join(configDir, ".claude.json")}`,
      `Backup: ${backup}`,
    ])
    expect(describeInvalidConfig({ ...result, startup_failure_reason: "cwd_unavailable" }, "gone")).toBeNull()
  })

  it("puts back the backup the failure named, once", async () => {
    const backup = join(backups, ".claude.json.backup.1763400000000")
    writeFileSync(backup, '{"numStartups": 2}')
    describeInvalidConfig(startupFailure(configDir, backup), "detail")

    await expect(restoreReportedConfig(join(configDir, ".claude.json"))).resolves.toEqual({ path: join(configDir, ".claude.json"), backupPath: backup })
    expect(readFileSync(join(configDir, ".claude.json"), "utf8")).toBe('{"numStartups": 2}')
    await expect(restoreReportedConfig(join(configDir, ".claude.json"))).rejects.toMatchObject({ status: 404 })
  })

  it("restores nothing a failure did not name, or that has no backup", async () => {
    await expect(restoreReportedConfig(join(configDir, ".claude.json"))).rejects.toMatchObject({ status: 404 })
    describeInvalidConfig(startupFailure(configDir), "detail")
    await expect(restoreReportedConfig(join(configDir, ".claude.json"))).rejects.toMatchObject({ status: 404 })
  })

  it("restores only the global config file, and only from its own backups", async () => {
    const outside = mkdtempSync(join(tmpdir(), "config-repair-elsewhere-"))
    try {
      const stray = join(outside, ".claude.json.backup.1")
      writeFileSync(stray, "{}")
      describeInvalidConfig(startupFailure(configDir, stray), "detail")
      await expect(restoreReportedConfig(join(configDir, ".claude.json"))).rejects.toMatchObject({ status: 403 })

      const project = join(outside, ".claude.json")
      describeInvalidConfig({ ...startupFailure(outside, join(backups, ".claude.json.backup.1")), invalid_config_file: { path: project, is_global: false, backup_searched: false, backup_path: join(backups, ".claude.json.backup.1") } }, "detail")
      await expect(restoreReportedConfig(project)).rejects.toMatchObject({ status: 403 })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
    expect(readFileSync(join(configDir, ".claude.json"), "utf8")).toBe('{"numStartups": 3,')
  })

  it("leaves the file alone when the backup does not parse either", async () => {
    const backup = join(backups, ".claude.json.backup.1763400000000")
    writeFileSync(backup, "{not json")
    describeInvalidConfig(startupFailure(configDir, backup), "detail")

    await expect(restoreReportedConfig(join(configDir, ".claude.json"))).rejects.toMatchObject({ status: 422 })
    expect(readFileSync(join(configDir, ".claude.json"), "utf8")).toBe('{"numStartups": 3,')
  })
})
