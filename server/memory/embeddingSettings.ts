/**
 * The embedding endpoint in `<memory dir>/config.json`, as the app's settings
 * read, test and change it. The indexer and `cogpit-memory` read the same file.
 */
import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import type { EmbeddingSettingsInput, EmbeddingSettingsReport, EmbeddingTestResult } from "../../shared/contracts/memoryEmbeddings"
import {
  createEmbeddingClient,
  DEFAULT_DIMENSIONS,
  DEFAULT_MIN_SCORE,
  embeddingEnvOverrides,
  embeddingFingerprint,
  MEMORY_CONFIG_FILE,
  parseEmbeddingConfig,
  updateEmbeddingConfigText,
  type EmbeddingConfig,
  type FetchLike,
} from "../../shared/memory/embeddings"
import { embeddingCounts } from "../../shared/memory/store"
import { writeOwnerOnlyText } from "../atomicJsonFile"
import type { MemoryIndexer } from "./indexer"

/** A test waits longer than a search does: the first request may load the model. */
const TEST_TIMEOUT_MS = 15_000
const TEST_QUERY = "Which session fixed the login bug?"

type Env = Readonly<Record<string, string | undefined>>

async function readConfigText(dir: string): Promise<string | null> {
  try {
    return await readFile(join(dir, MEMORY_CONFIG_FILE), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

function unreadable(error: unknown): string {
  return `config.json could not be read: ${error instanceof Error ? error.message : String(error)}`
}

/** The form as a change to the file's section; a key that was not typed is left to the file. */
function changesFor(input: EmbeddingSettingsInput): Partial<EmbeddingConfig> {
  return {
    url: input.url,
    model: input.model,
    queryPrefix: input.queryPrefix ?? "",
    ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
    ...(input.dimensions === undefined ? {} : { dimensions: input.dimensions }),
    ...(input.minScore === undefined ? {} : { minScore: input.minScore }),
  }
}

/**
 * The settings the file holds, which are what the form edits, with progress
 * and failures for the configuration in effect, environment overrides included.
 */
export async function embeddingSettingsReport(
  dir: string,
  indexer: Pick<MemoryIndexer, "store" | "embeddingError"> | null,
  env: Env = process.env,
): Promise<EmbeddingSettingsReport> {
  let saved: ReturnType<typeof parseEmbeddingConfig>
  let effective: ReturnType<typeof parseEmbeddingConfig>
  try {
    const text = await readConfigText(dir)
    saved = parseEmbeddingConfig(text, {})
    effective = parseEmbeddingConfig(text, env)
  } catch (error) {
    saved = effective = { config: null, error: unreadable(error) }
  }
  const store = indexer?.store() ?? null
  const counts = effective.config && store ? embeddingCounts(store, embeddingFingerprint(effective.config)) : null
  return {
    settings: saved.config && {
      url: saved.config.url,
      model: saved.config.model,
      dimensions: saved.config.dimensions,
      queryPrefix: saved.config.queryPrefix ?? "",
      minScore: saved.config.minScore ?? DEFAULT_MIN_SCORE,
      hasApiKey: !!saved.config.apiKey,
    },
    progress: counts && { passages: counts.embedded + counts.pending, embedded: counts.embedded },
    error: saved.error ?? effective.error ?? (effective.config ? indexer?.embeddingError() ?? null : null),
    defaults: { dimensions: DEFAULT_DIMENSIONS, minScore: DEFAULT_MIN_SCORE },
    overrides: embeddingEnvOverrides(env),
  }
}

/** Save the endpoint the form describes, or turn embeddings off with `null`. */
export async function saveEmbeddingSettings(dir: string, input: EmbeddingSettingsInput | null): Promise<{ error?: string }> {
  let text: string | null
  try {
    text = await readConfigText(dir)
  } catch (error) {
    return { error: unreadable(error) }
  }
  const updated = updateEmbeddingConfigText(text, input && changesFor(input))
  if ("error" in updated) return updated
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeOwnerOnlyText(join(dir, MEMORY_CONFIG_FILE), updated.text)
  return {}
}

/** Embed one question with what saving the form would write, without saving it. */
export async function testEmbeddingSettings(dir: string, input: EmbeddingSettingsInput, fetch: FetchLike): Promise<EmbeddingTestResult> {
  let updated: ReturnType<typeof updateEmbeddingConfigText>
  try {
    updated = updateEmbeddingConfigText(await readConfigText(dir), changesFor(input))
  } catch (error) {
    return { ok: false, error: unreadable(error) }
  }
  if ("error" in updated || !updated.config) return { ok: false, error: "error" in updated ? updated.error : "invalid embedding configuration" }
  const started = Date.now()
  try {
    await createEmbeddingClient({ ...updated.config, timeoutMs: TEST_TIMEOUT_MS }, fetch).embedQuery(TEST_QUERY)
    return { ok: true, ms: Date.now() - started }
  } catch (failure) {
    return { ok: false, error: failure instanceof Error ? failure.message : String(failure) }
  }
}
