// SHARED MEMORY CORE: edit shared/memory only; cogpit-memory copies are generated.
/**
 * Optional embeddings from any OpenAI-compatible `/v1/embeddings` endpoint.
 * Vectors are cut to the configured dimensions (Matryoshka), normalised and
 * stored as int8 with their norm. Nothing here may make a caller fail when no
 * endpoint is configured or reachable: errors come back as values.
 */
import { MAX_CHUNK_CHARS } from "./chunker"

export interface EmbeddingConfig {
  /** Full URL of the embeddings endpoint, e.g. http://127.0.0.1:8790/v1/embeddings. */
  url: string
  model: string
  apiKey?: string
  /** Dimensions kept per vector. */
  dimensions: number
  /** Prepended to a query, never to a document (instruction-tuned models). */
  queryPrefix?: string
  /** Cosine similarity a vector hit must reach. */
  minScore?: number
  /** How long a search waits for its query embedding. */
  timeoutMs?: number
}

export const MEMORY_CONFIG_FILE = "config.json"
export const DEFAULT_DIMENSIONS = 256
export const DEFAULT_MIN_SCORE = 0.55
export const DEFAULT_QUERY_TIMEOUT_MS = 1500
const DOCUMENT_TIMEOUT_MS = 120_000
const ATTEMPTS = 3
const RETRY_DELAY_MS = 500

/** Environment overrides, for tests and one-off runs. */
const ENV = {
  url: "COGPIT_EMBED_URL",
  model: "COGPIT_EMBED_MODEL",
  apiKey: "COGPIT_EMBED_API_KEY",
  dimensions: "COGPIT_EMBED_DIMENSIONS",
  queryPrefix: "COGPIT_EMBED_QUERY_PREFIX",
  minScore: "COGPIT_EMBED_MIN_SCORE",
  timeoutMs: "COGPIT_EMBED_TIMEOUT_MS",
} as const

export function embeddingFingerprint(config: Pick<EmbeddingConfig, "model" | "dimensions">): string {
  return `${config.model}@${config.dimensions}`
}

/**
 * The `embeddings` section of `<memory dir>/config.json` with environment
 * overrides applied. `config: null` without `error` means embeddings are off.
 */
export function parseEmbeddingConfig(
  fileText: string | null,
  env: Readonly<Record<string, string | undefined>>,
): { config: EmbeddingConfig | null; error?: string } {
  let section: Record<string, unknown> = {}
  if (fileText !== null && fileText.trim()) {
    try {
      const parsed = JSON.parse(fileText) as { embeddings?: unknown }
      if (parsed.embeddings !== undefined && (typeof parsed.embeddings !== "object" || parsed.embeddings === null)) {
        return { config: null, error: "config.json: embeddings must be an object" }
      }
      section = { ...(parsed.embeddings as Record<string, unknown> | undefined) }
    } catch (error) {
      return { config: null, error: `config.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  for (const [key, name] of Object.entries(ENV)) {
    const value = env[name]
    // A query prefix may end in a space or newline that matters to the model, so only blank values are skipped.
    if (value?.trim()) section[key] = ["dimensions", "minScore", "timeoutMs"].includes(key) ? Number(value) : key === "queryPrefix" ? value : value.trim()
  }
  if (!section.url && !section.model) return { config: null }
  return validateEmbeddingConfig(section)
}

export function validateEmbeddingConfig(section: Record<string, unknown>): { config: EmbeddingConfig | null; error?: string } {
  const fail = (error: string) => ({ config: null, error: `embeddings: ${error}` })
  const { url, model, apiKey, queryPrefix } = section
  const dimensions = section.dimensions ?? DEFAULT_DIMENSIONS
  if (typeof url !== "string" || !/^https?:\/\/\S+$/.test(url)) return fail("url must be an http(s) URL")
  if (typeof model !== "string" || !model.trim()) return fail("model is required")
  if (typeof dimensions !== "number" || !Number.isInteger(dimensions) || dimensions < 8 || dimensions > 8192) return fail("dimensions must be a whole number from 8 to 8192")
  if (apiKey !== undefined && typeof apiKey !== "string") return fail("apiKey must be a string")
  if (queryPrefix !== undefined && typeof queryPrefix !== "string") return fail("queryPrefix must be a string")
  const minScore = section.minScore ?? DEFAULT_MIN_SCORE
  if (typeof minScore !== "number" || !(minScore >= -1 && minScore <= 1)) return fail("minScore must be between -1 and 1")
  const timeoutMs = section.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS
  if (typeof timeoutMs !== "number" || !(timeoutMs >= 50 && timeoutMs <= 600_000)) return fail("timeoutMs must be from 50 to 600000")
  return {
    config: {
      url,
      model: model.trim(),
      ...(apiKey ? { apiKey } : {}),
      dimensions,
      ...(queryPrefix ? { queryPrefix } : {}),
      minScore,
      timeoutMs,
    },
  }
}

/** The `COGPIT_EMBED_*` variables set in `env`, which replace what `config.json` says while they are. */
export function embeddingEnvOverrides(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.values(ENV).filter((name) => env[name]?.trim())
}

/** Whether two endpoint addresses are on one origin; false when either is not a URL. */
export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

/**
 * `config.json` with `changes` merged into its `embeddings` section, or with
 * the section removed when `changes` is null. Other sections are kept. A saved
 * API key stays with the origin it was saved for: moving the endpoint to
 * another origin without giving a key drops it.
 */
export function updateEmbeddingConfigText(
  fileText: string | null,
  changes: Partial<EmbeddingConfig> | null,
): { text: string; config: EmbeddingConfig | null } | { error: string } {
  let file: Record<string, unknown> = {}
  if (fileText?.trim()) {
    try {
      file = JSON.parse(fileText) as Record<string, unknown>
    } catch (error) {
      return { error: `config.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (typeof file !== "object" || file === null || Array.isArray(file)) return { error: "config.json must hold an object" }
  }
  let config: EmbeddingConfig | null = null
  if (changes === null) {
    delete file.embeddings
  } else {
    const saved = file.embeddings as Record<string, unknown> | undefined
    const merged: Record<string, unknown> = { ...saved, ...changes }
    const moved = typeof saved?.url === "string" && typeof changes.url === "string" && !sameOrigin(saved.url, changes.url)
    if (moved && changes.apiKey === undefined) delete merged.apiKey
    const validated = validateEmbeddingConfig(merged)
    if (!validated.config) return { error: validated.error ?? "invalid embedding configuration" }
    file.embeddings = config = validated.config
  }
  return { text: `${JSON.stringify(file, null, 2)}\n`, config }
}

/** The subset of `fetch` the client uses, injected so shared code does no I/O of its own. */
export type FetchLike = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>

/** A vector as stored: int8 components and the norm of those components. */
export interface QuantizedVector {
  values: Int8Array
  norm: number
}

export interface EmbeddingClient {
  readonly config: EmbeddingConfig
  readonly fingerprint: string
  embedDocuments(texts: string[], signal?: AbortSignal): Promise<QuantizedVector[]>
  embedQuery(text: string, signal?: AbortSignal): Promise<QuantizedVector>
}

export class EmbeddingError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message)
    this.name = "EmbeddingError"
  }
}

/**
 * Cut to `dimensions`, normalise, and scale so the largest component is 127.
 * The scale cancels out of the cosine, so it is not stored.
 */
export function quantize(raw: readonly unknown[], dimensions: number): QuantizedVector {
  if (raw.length < dimensions) throw new EmbeddingError(`the endpoint returned ${raw.length} dimensions; the configuration keeps ${dimensions}`, false)
  let max = 0
  for (let i = 0; i < dimensions; i++) {
    const component = raw[i]
    if (typeof component !== "number" || !Number.isFinite(component)) throw new EmbeddingError("the endpoint returned a vector with a component that is not a number", false)
    max = Math.max(max, Math.abs(component))
  }
  if (max === 0) throw new EmbeddingError("the endpoint returned a zero vector", false)
  const values = new Int8Array(dimensions)
  let squares = 0
  for (let i = 0; i < dimensions; i++) {
    const value = Math.round(((raw[i] as number) / max) * 127)
    values[i] = value
    squares += value * value
  }
  return { values, norm: Math.sqrt(squares) }
}

/** Cosine similarity of two stored vectors. */
export function cosine(a: QuantizedVector, b: Int8Array, bNorm: number): number {
  if (a.norm === 0 || bNorm === 0) return 0
  let dot = 0
  for (let i = 0; i < b.length; i++) dot += a.values[i]! * b[i]!
  return dot / (a.norm * bNorm)
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve() }, { once: true })
  })
}

function timeoutSignal(ms: number, outer?: AbortSignal): { signal: AbortSignal; done(): void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new EmbeddingError(`the embedding endpoint did not answer within ${ms} ms`, true)), ms)
  const forward = () => controller.abort(outer?.reason)
  outer?.addEventListener("abort", forward, { once: true })
  return { signal: controller.signal, done: () => { clearTimeout(timer); outer?.removeEventListener("abort", forward) } }
}

export function createEmbeddingClient(config: EmbeddingConfig, fetch: FetchLike): EmbeddingClient {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`
  // An endpoint may echo the key in an error body; messages are printed, so the key never reaches one.
  const redact = (error: EmbeddingError) => !config.apiKey || !error.message.includes(config.apiKey)
    ? error
    : new EmbeddingError(error.message.split(config.apiKey).join("[redacted]"), error.retryable)

  async function request(input: string[], timeoutMs: number, attempts: number, signal?: AbortSignal): Promise<unknown[][]> {
    let lastError: EmbeddingError = new EmbeddingError("no attempt was made", true)
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await delay(RETRY_DELAY_MS * 3 ** (attempt - 1), signal)
      if (signal?.aborted) throw new EmbeddingError("cancelled", false)
      const timer = timeoutSignal(timeoutMs, signal)
      try {
        const response = await fetch(config.url, { method: "POST", headers, body: JSON.stringify({ model: config.model, input }), signal: timer.signal })
        if (!response.ok) {
          const detail = (await response.text().catch(() => "")).slice(0, 200)
          lastError = new EmbeddingError(`the embedding endpoint answered ${response.status}${detail ? `: ${detail}` : ""}`, response.status === 429 || response.status >= 500)
        } else {
          return parseEmbeddings(await response.json(), input.length)
        }
      } catch (error) {
        if (error instanceof EmbeddingError) lastError = error
        else if (timer.signal.reason instanceof EmbeddingError) lastError = timer.signal.reason
        else lastError = new EmbeddingError(`the embedding endpoint could not be reached: ${error instanceof Error ? error.message : String(error)}`, !signal?.aborted)
      } finally {
        timer.done()
      }
      if (!lastError.retryable) break
    }
    throw redact(lastError)
  }

  return {
    config,
    fingerprint: embeddingFingerprint(config),
    async embedDocuments(texts, signal) {
      const vectors = await request(texts.map((text) => text.slice(0, MAX_CHUNK_CHARS)), DOCUMENT_TIMEOUT_MS, ATTEMPTS, signal)
      return vectors.map((vector) => quantize(vector, config.dimensions))
    },
    async embedQuery(text, signal) {
      const [vector] = await request([`${config.queryPrefix ?? ""}${text.slice(0, MAX_CHUNK_CHARS)}`], config.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS, 1, signal)
      return quantize(vector!, config.dimensions)
    },
  }
}

function parseEmbeddings(body: unknown, expected: number): unknown[][] {
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data) || data.length !== expected) {
    throw new EmbeddingError(`the embedding endpoint returned ${Array.isArray(data) ? data.length : "no"} vectors for ${expected} inputs`, false)
  }
  const vectors: unknown[][] = new Array(expected)
  data.forEach((item: { index?: unknown; embedding?: unknown }, position) => {
    const index = typeof item?.index === "number" ? item.index : position
    if (!Array.isArray(item?.embedding) || index < 0 || index >= expected || vectors[index]) {
      throw new EmbeddingError("the embedding endpoint returned a malformed vector list", false)
    }
    vectors[index] = item.embedding
  })
  return vectors
}
