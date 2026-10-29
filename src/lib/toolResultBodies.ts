import { authFetch } from "@/lib/auth"
import { getActiveDeviceScope, getActiveIdentity } from "@/lib/device"
import type { ToolResultBodyResponse, ToolResultUnavailable } from "../../shared/contracts/toolResults"
import type { ElidedResult } from "../../shared/session/types"

/**
 * Elided tool-result bodies a reader expanded, fetched from the server that
 * projected them and kept in a small cache bounded by characters. Keys carry
 * the device and signed-in identity, so switching either never serves a body
 * fetched for the other.
 */

export type BodyChunk = ToolResultBodyResponse
export class BodyUnavailable extends Error {
  constructor(readonly reason: ToolResultUnavailable, message: string) { super(message); this.name = "BodyUnavailable" }
}

/** Characters of fetched bodies kept across expansions. */
export const BODY_CACHE_CHARS = 8 * 1024 * 1024
const cache = new Map<string, BodyChunk>()
let cachedChars = 0

function cacheKey(ref: string, start: number): string {
  return JSON.stringify([getActiveDeviceScope(), getActiveIdentity(), ref, start])
}

function bodyUrl(stub: ElidedResult, start: number): string {
  return `/api/tool-result/${encodeURIComponent(stub.source.dirName)}/${encodeURIComponent(stub.source.fileName)}?ref=${encodeURIComponent(stub.ref)}&start=${start}`
}

function remember(key: string, chunk: BodyChunk): void {
  const old = cache.get(key)
  if (old) { cache.delete(key); cachedChars -= old.text.length }
  if (chunk.text.length > BODY_CACHE_CHARS) return
  cache.set(key, chunk)
  cachedChars += chunk.text.length
  for (const [oldest, value] of cache) {
    if (cachedChars <= BODY_CACHE_CHARS) break
    cache.delete(oldest)
    cachedChars -= value.text.length
  }
}

function unavailable(status: number, state: unknown): BodyUnavailable {
  if (state === "stale" || status === 410) return new BodyUnavailable("stale", "This output changed or was removed from the transcript. Reload the session to see what it holds now.")
  if (state === "too_large" || status === 413) return new BodyUnavailable("too_large", "This output is too large to show here.")
  if (status === 401 || status === 403 || status === 404) return new BodyUnavailable("denied", "You no longer have access to this output.")
  if (status === 400) return new BodyUnavailable("invalid", "This output reference is not valid on this server.")
  return new BodyUnavailable("error", "The output could not be loaded.")
}

/** One chunk of a body, from the cache or the server. */
export async function fetchBodyChunk(stub: ElidedResult, start: number, signal?: AbortSignal): Promise<BodyChunk> {
  const key = cacheKey(stub.ref, start)
  const cached = cache.get(key)
  if (cached) {
    cache.delete(key)
    cache.set(key, cached)
    return cached
  }
  const response = await authFetch(bodyUrl(stub, start), { signal })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { state?: unknown }
    throw unavailable(response.status, body.state)
  }
  const chunk = await response.json() as BodyChunk
  if (cacheKey(stub.ref, start) === key) remember(key, chunk)
  return chunk
}

/** A whole body, chunk after chunk, for copying; stops at `limitChars`. */
export async function fetchFullBody(stub: ElidedResult, limitChars = BODY_CACHE_CHARS): Promise<string> {
  let text = ""
  for (;;) {
    const chunk = await fetchBodyChunk(stub, text.length)
    text += chunk.text
    if (chunk.end >= chunk.total || !chunk.text || text.length >= limitChars) return text
  }
}

export function __resetToolResultBodiesForTest(): void { cache.clear(); cachedChars = 0 }
export function cachedBodyChars(): number { return cachedChars }
