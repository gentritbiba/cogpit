/**
 * The embedding endpoint in `<memory dir>/config.json`, as the app's settings
 * read, test and change it. The indexer and `cogpit-memory` read the same file.
 */
import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { sameEmbeddingOrigin, type EmbeddingSettingsInput, type EmbeddingSettingsReport, type EmbeddingTestResult } from "../../shared/contracts/memoryEmbeddings"
import {
  createEmbeddingClient,
  DEFAULT_DIMENSIONS,
  DEFAULT_MIN_SCORE,
  embeddingFingerprint,
  MEMORY_CONFIG_FILE,
  parseEmbeddingConfig,
  updateEmbeddingConfigText,
  validateEmbeddingConfig,
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

/**
 * The section the form describes. A key that was not typed again is the saved
 * one only while the endpoint stays on its origin, so the saved key is never
 * sent to an address it was not entered for.
 */
function sectionFor(input: EmbeddingSettingsInput, saved: EmbeddingConfig | null): Partial<EmbeddingConfig> {
  const keptKey = saved && sameEmbeddingOrigin(saved.url, input.url) ? saved.apiKey : undefined
  return {
    url: input.url,
    model: input.model,
    apiKey: input.apiKey ?? keptKey ?? "",
    queryPrefix: input.queryPrefix ?? "",
    ...(input.dimensions === undefined ? {} : { dimensions: input.dimensions }),
    ...(input.minScore === undefined ? {} : { minScore: input.minScore }),
  }
}

/** The file's own section, without environment overrides: what a save changes. */
function savedSection(text: string | null): EmbeddingConfig | null {
  return parseEmbeddingConfig(text, {}).config
}

export async function embeddingSettingsReport(
  dir: string,
  indexer: Pick<MemoryIndexer, "store" | "embeddingError"> | null,
  env: Env = process.env,
): Promise<EmbeddingSettingsReport> {
  let parsed: ReturnType<typeof parseEmbeddingConfig>
  try {
    parsed = parseEmbeddingConfig(await readConfigText(dir), env)
  } catch (error) {
    parsed = { config: null, error: `config.json could not be read: ${error instanceof Error ? error.message : String(error)}` }
  }
  const { config } = parsed
  const store = indexer?.store() ?? null
  const counts = config && store ? embeddingCounts(store, embeddingFingerprint(config)) : null
  return {
    settings: config && {
      url: config.url,
      model: config.model,
      dimensions: config.dimensions,
      queryPrefix: config.queryPrefix ?? "",
      minScore: config.minScore ?? DEFAULT_MIN_SCORE,
      hasApiKey: !!config.apiKey,
    },
    progress: counts && { passages: counts.embedded + counts.pending, embedded: counts.embedded },
    error: parsed.error ?? (config ? indexer?.embeddingError() ?? null : null),
    defaults: { dimensions: DEFAULT_DIMENSIONS, minScore: DEFAULT_MIN_SCORE },
  }
}

/** Save the endpoint the form describes, or turn embeddings off with `null`. */
export async function saveEmbeddingSettings(dir: string, input: EmbeddingSettingsInput | null): Promise<{ error?: string }> {
  let text: string | null
  try {
    text = await readConfigText(dir)
  } catch (error) {
    return { error: `config.json could not be read: ${error instanceof Error ? error.message : String(error)}` }
  }
  const updated = updateEmbeddingConfigText(text, input && sectionFor(input, savedSection(text)))
  if ("error" in updated) return updated
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeOwnerOnlyText(join(dir, MEMORY_CONFIG_FILE), updated.text)
  return {}
}

/** Embed one question with the endpoint the form describes, saved or not. */
export async function testEmbeddingSettings(dir: string, input: EmbeddingSettingsInput, fetch: FetchLike): Promise<EmbeddingTestResult> {
  const saved = savedSection(await readConfigText(dir).catch(() => null))
  const { config, error } = validateEmbeddingConfig({ ...sectionFor(input, saved), timeoutMs: TEST_TIMEOUT_MS })
  if (!config) return { ok: false, error: error ?? "invalid embedding configuration" }
  const started = Date.now()
  try {
    await createEmbeddingClient(config, fetch).embedQuery(TEST_QUERY)
    return { ok: true, ms: Date.now() - started }
  } catch (failure) {
    return { ok: false, error: failure instanceof Error ? failure.message : String(failure) }
  }
}
