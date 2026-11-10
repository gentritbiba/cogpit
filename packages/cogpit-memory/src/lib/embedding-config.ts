/**
 * The embedding endpoint the memory store's `config.json` names, shared with
 * the Cogpit app. Missing or broken configuration turns embeddings off; it
 * never stops a command.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { memoryDir } from "./memory-store"
import {
  createEmbeddingClient,
  MEMORY_CONFIG_FILE,
  parseEmbeddingConfig,
  validateEmbeddingConfig,
  type EmbeddingClient,
  type EmbeddingConfig,
} from "./memory/embeddings"

export interface LoadedEmbeddings {
  client: EmbeddingClient | null
  /** Why embeddings are off: not configured, or the file is broken. */
  reason?: string
  error?: string
}

export function memoryConfigPath(dir = memoryDir()): string {
  return join(dir, MEMORY_CONFIG_FILE)
}

function readConfigText(path: string): string | null {
  try {
    return readFileSync(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

export function loadEmbeddings(dir = memoryDir()): LoadedEmbeddings {
  let text: string | null
  try {
    text = readConfigText(memoryConfigPath(dir))
  } catch (error) {
    return { client: null, error: `config.json could not be read: ${error instanceof Error ? error.message : String(error)}` }
  }
  const { config, error } = parseEmbeddingConfig(text, process.env)
  if (error) return { client: null, error }
  if (!config) return { client: null, reason: "no embedding endpoint is configured; see `cogpit-memory index config`" }
  return { client: createEmbeddingClient(config, fetch) }
}

/** The configuration with the API key masked, for printing. */
export function describeConfig(config: EmbeddingConfig): Omit<EmbeddingConfig, "apiKey"> & { apiKey?: string } {
  return { ...config, ...(config.apiKey ? { apiKey: "(set)" } : {}) }
}

/**
 * Merge `changes` into the `embeddings` section of config.json, or remove it
 * with `off`. The file is written owner-only; other sections are kept.
 */
export function writeEmbeddingConfig(changes: Partial<EmbeddingConfig>, options: { off?: boolean; dir?: string } = {}): { path: string; embeddings: ReturnType<typeof describeConfig> | null } | { error: string } {
  const dir = options.dir ?? memoryDir()
  const path = memoryConfigPath(dir)
  let file: Record<string, unknown> = {}
  try {
    const text = readConfigText(path)
    if (text?.trim()) file = JSON.parse(text) as Record<string, unknown>
  } catch (error) {
    return { error: `config.json could not be read: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (options.off) {
    delete file.embeddings
  } else {
    const merged = { ...(file.embeddings as Record<string, unknown> | undefined), ...changes }
    const { config, error } = validateEmbeddingConfig(merged)
    if (!config) return { error: error ?? "invalid embedding configuration" }
    file.embeddings = config
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
  const embeddings = file.embeddings ? describeConfig(file.embeddings as EmbeddingConfig) : null
  return { path, embeddings }
}
