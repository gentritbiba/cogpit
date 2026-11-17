// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { describeStartupFailure, restoreReportedConfig } from "../../agents/startupFailures"

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
    const message = describeStartupFailure(result, result.errors[0])

    expect(message?.split("\n").slice(0, 3)).toEqual([
      "Claude Code can't start: a config file isn't valid JSON.",
      `File: ${join(configDir, ".claude.json")}`,
      `Backup: ${backup}`,
    ])
    expect(describeStartupFailure({ ...result, startup_failure_reason: "cwd_unavailable" }, "gone")).toBeNull()
  })

  it("puts back the backup the failure named, once", async () => {
    const backup = join(backups, ".claude.json.backup.1763400000000")
    writeFileSync(backup, '{"numStartups": 2}')
    describeStartupFailure(startupFailure(configDir, backup), "detail")

    await expect(restoreReportedConfig(join(configDir, ".claude.json"))).resolves.toEqual({ path: join(configDir, ".claude.json"), backupPath: backup })
    expect(readFileSync(join(configDir, ".claude.json"), "utf8")).toBe('{"numStartups": 2}')
    await expect(restoreReportedConfig(join(configDir, ".claude.json"))).rejects.toMatchObject({ status: 404 })
  })

  it("restores nothing a failure did not name, or that has no backup", async () => {
    await expect(restoreReportedConfig(join(configDir, ".claude.json"))).rejects.toMatchObject({ status: 404 })
    describeStartupFailure(startupFailure(configDir), "detail")
    await expect(restoreReportedConfig(join(configDir, ".claude.json"))).rejects.toMatchObject({ status: 404 })
  })

  it("restores only the global config file, and only from its own backups", async () => {
    const outside = mkdtempSync(join(tmpdir(), "config-repair-elsewhere-"))
    try {
      const stray = join(outside, ".claude.json.backup.1")
      writeFileSync(stray, "{}")
      describeStartupFailure(startupFailure(configDir, stray), "detail")
      await expect(restoreReportedConfig(join(configDir, ".claude.json"))).rejects.toMatchObject({ status: 403 })

      const project = join(outside, ".claude.json")
      describeStartupFailure({ ...startupFailure(outside, join(backups, ".claude.json.backup.1")), invalid_config_file: { path: project, is_global: false, backup_searched: false, backup_path: join(backups, ".claude.json.backup.1") } }, "detail")
      await expect(restoreReportedConfig(project)).rejects.toMatchObject({ status: 403 })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
    expect(readFileSync(join(configDir, ".claude.json"), "utf8")).toBe('{"numStartups": 3,')
  })

  it("leaves the file alone when the backup does not parse either", async () => {
    const backup = join(backups, ".claude.json.backup.1763400000000")
    writeFileSync(backup, "{not json")
    describeStartupFailure(startupFailure(configDir, backup), "detail")

    await expect(restoreReportedConfig(join(configDir, ".claude.json"))).rejects.toMatchObject({ status: 422 })
    expect(readFileSync(join(configDir, ".claude.json"), "utf8")).toBe('{"numStartups": 3,')
  })
})

describe("a resume refused because the session was started in Code Mode", () => {
  // What Claude Code 2.1.326 answered a headless resume of a session carrying a `repl-mode` record.
  const sessionId = "5b0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d"
  const cliText = `Failed to resume session: This session was started in Code Mode (experimental), which isn't available because for now it only works in the interactive terminal, so it can't be resumed here. Resume it in the terminal: CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 claude --resume ${sessionId}`
  const refusal = { type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, session_id: sessionId, errors: [cliText] }

  it("says to continue in the terminal, with the CLI's own command", () => {
    expect(describeStartupFailure(refusal, cliText)).toBe([
      "This session was started in Code Mode, so it can only be continued in Claude Code in a terminal.",
      `Continue it in a terminal: CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 claude --resume ${sessionId}`,
      cliText,
    ].join("\n"))
  })

  it("builds the command when the CLI's text leaves it out", () => {
    const text = "Failed to resume session: This session was started in Code Mode (experimental), which you chose not to turn on, so it can't be resumed."
    expect(describeStartupFailure({ ...refusal, errors: [text] }, text)?.split("\n")[1])
      .toBe(`Continue it in a terminal: CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 claude --resume ${sessionId}`)
  })

  it("leaves a session that continued without Code Mode alone", () => {
    const notice = "This session was started in Code Mode (experimental), which isn't available where it runs now. It continues with the ordinary tools and stays out of Code Mode from now on."
    expect(describeStartupFailure({ ...refusal, errors: [notice] }, notice)).toBeNull()
  })
})
