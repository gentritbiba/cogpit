import { readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { agentConfigInvalidMessage, type InvalidAgentConfig } from "../../shared/session/agentFailures"

/**
 * Claude Code refuses to start while its global config file is not valid JSON
 * (`config_file_invalid`, 2.1.318+), and names the file and a backup. Each
 * start that failed that way is remembered here, so the backup can be put back
 * from the error, and nothing a start did not name can be.
 */
const reported = new Map<string, InvalidAgentConfig>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function invalidConfigFileOf(result: Record<string, unknown>): InvalidAgentConfig | null {
  if (result.startup_failure_reason !== "config_file_invalid") return null
  const file = result.invalid_config_file
  if (!isRecord(file) || typeof file.path !== "string") return null
  return { path: file.path, backupPath: typeof file.backup_path === "string" ? file.backup_path : null }
}

/**
 * The message for a start that failed over an invalid config file, which also
 * remembers the file and its backup. Null for any other result.
 */
export function describeInvalidConfig(result: Record<string, unknown>, detail: string): string | null {
  const file = invalidConfigFileOf(result)
  if (!file) return null
  reported.set(file.path, file)
  return agentConfigInvalidMessage("claude", file, detail)
}

/** Where this server's Claude Code keeps its global config file and that file's backups. */
function claudeGlobalConfig(): { file: string; backups: string } {
  const configDir = process.env.CLAUDE_CONFIG_DIR
  if (configDir) return { file: join(resolve(configDir), ".claude.json"), backups: join(resolve(configDir), "backups") }
  return { file: join(homedir(), ".claude.json"), backups: join(homedir(), ".claude", "backups") }
}

export class ConfigRestoreError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/**
 * Copy the backup a failed start named over the config file it named. Only the
 * global config file and one of its own backups qualify, and only a backup
 * that parses: the CLI may name the newest backup even when none does.
 */
export async function restoreReportedConfig(path: string): Promise<InvalidAgentConfig & { backupPath: string }> {
  const file = reported.get(path)
  if (!file?.backupPath) throw new ConfigRestoreError(404, "No failed start named a backup for this file.")
  const { backupPath } = file
  const global = claudeGlobalConfig()
  const ownBackup = dirname(resolve(backupPath)) === global.backups && basename(backupPath).startsWith(".claude.json.backup.")
  if (resolve(file.path) !== global.file || !ownBackup) {
    throw new ConfigRestoreError(403, "Only Claude Code's own config file can be restored, from its own backups.")
  }
  let text: string
  let backup: unknown
  try {
    text = await readFile(backupPath, "utf8")
    backup = JSON.parse(text)
  } catch {
    throw new ConfigRestoreError(422, `The backup is not valid JSON either: ${backupPath}`)
  }
  if (!isRecord(backup)) throw new ConfigRestoreError(422, `The backup is not a config file: ${backupPath}`)
  await writeFile(file.path, text)
  reported.delete(path)
  return { path: file.path, backupPath }
}
