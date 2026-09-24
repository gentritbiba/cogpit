import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { writeOwnerOnlyJson } from "../atomicJsonFile"
import { dirs } from "../dirs"

/**
 * Per-session UI configuration (model, effort, permission mode, MCP selection
 * …) kept as `dirs.SESSION_CONFIG_DIR/<key>.json`. Keys are a session's
 * `<sessionId>.jsonl` or a project dirName. Changes to one key are written one
 * at a time, so writers never lose each other's fields.
 */

export type SessionConfig = Record<string, unknown>

/** The key a session's own config is kept under. */
export function sessionConfigKey(sessionId: string): string {
  return `${sessionId}.jsonl`
}

function configFilePath(key: string): string {
  return join(dirs.SESSION_CONFIG_DIR, `${key}.json`)
}

export async function readSessionConfig(key: string): Promise<SessionConfig> {
  try {
    const parsed: unknown = JSON.parse(await readFile(configFilePath(key), "utf-8"))
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as SessionConfig
  } catch {
    // Missing or corrupted file — treat as empty config.
  }
  return {}
}

/** A write to one key's config: what it held before and after, and the fields whose value moved. */
export interface SessionConfigUpdate {
  before: SessionConfig
  config: SessionConfig
  changed: string[]
}

const writes = new Map<string, Promise<unknown>>()

function inTurn<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const result = (writes.get(key) ?? Promise.resolve()).then(operation)
  const settled = result.catch(() => {})
  writes.set(key, settled)
  void settled.then(() => {
    if (writes.get(key) === settled) writes.delete(key)
  })
  return result
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Merge the patch `change` makes of the stored config into it and write the
 * result; a field set to null is removed. `change` runs in turn with every
 * other write to the key, so it sees what they left.
 */
export function updateSessionConfig(key: string, change: (stored: SessionConfig) => SessionConfig): Promise<SessionConfigUpdate> {
  return inTurn(key, async () => {
    const before = await readSessionConfig(key)
    const config: SessionConfig = { ...before, ...change(before) }
    for (const [field, value] of Object.entries(config)) {
      if (value === null) delete config[field]
    }
    await mkdir(dirs.SESSION_CONFIG_DIR, { recursive: true })
    await writeOwnerOnlyJson(configFilePath(key), config)
    const fields = new Set([...Object.keys(before), ...Object.keys(config)])
    return { before, config, changed: [...fields].filter((field) => !sameValue(before[field], config[field])) }
  })
}
