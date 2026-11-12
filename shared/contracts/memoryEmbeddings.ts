/**
 * /api/memory-embeddings: the embedding endpoint session search uses to match
 * by meaning. Host administrators only; the API key is never sent back.
 */

/** The saved endpoint as the app may show it. */
export interface EmbeddingSettingsView {
  url: string
  model: string
  dimensions: number
  queryPrefix: string
  minScore: number
  hasApiKey: boolean
}

export interface EmbeddingSettingsReport {
  /** Null when no endpoint is configured. */
  settings: EmbeddingSettingsView | null
  /** How much stored session text has a vector for the saved model; null when off or the store is not open yet. */
  progress: { passages: number; embedded: number } | null
  /** Why embedding is stopped: an unusable `config.json` or the endpoint's last failure. */
  error: string | null
  /** What a new endpoint starts with. */
  defaults: { dimensions: number; minScore: number }
}

/** What the form sends to save or test. */
export interface EmbeddingSettingsInput {
  url: string
  model: string
  /** Left out, the saved key is kept as long as the endpoint stays on the same origin. */
  apiKey?: string
  dimensions?: number
  queryPrefix?: string
  minScore?: number
}

export type EmbeddingSettingsRequest =
  | { action: "save"; settings: EmbeddingSettingsInput }
  | { action: "test"; settings: EmbeddingSettingsInput }
  | { action: "off" }

export type EmbeddingTestResult = { ok: true; ms: number } | { ok: false; error: string }

/** Whether a key saved for `savedUrl` may go to `url`: only to the origin it was entered for. */
export function sameEmbeddingOrigin(savedUrl: string, url: string): boolean {
  try {
    return new URL(savedUrl).origin === new URL(url).origin
  } catch {
    return false
  }
}

/**
 * The query instruction the default score floor was measured with. Only the
 * Qwen3-Embedding family is known to want one; every other model gets none.
 */
export function suggestedQueryPrefix(model: string): string {
  return /qwen3-embedding/i.test(model)
    ? "Instruct: Given a question about earlier work, retrieve the conversation passages that answer it\nQuery: "
    : ""
}
