import type { FetchLike } from "../../../shared/memory/embeddings"

/** Words that mean the same thing share an axis, so a fake model can match by meaning without sharing a word. */
const TOPICS: Record<string, number> = {
  car: 0, automobile: 0, vehicle: 0, engine: 0,
  pizza: 1, lunch: 1, food: 1, dinner: 1,
  deploy: 2, release: 2, ship: 2, rollout: 2,
  database: 3, sqlite: 3, storage: 3,
}

export const FAKE_DIMENSIONS = 16

/** A deterministic embedding: one axis per topic, a small hashed tail for the rest. */
export function fakeVector(text: string, dimensions = FAKE_DIMENSIONS): number[] {
  const vector = new Array<number>(dimensions).fill(0)
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    const topic = TOPICS[word]
    if (topic !== undefined) vector[topic] += 1
    else vector[8 + (word.length % (dimensions - 8))] += 0.05
  }
  return vector
}

export interface FakeEndpoint {
  fetch: FetchLike
  requests: Array<{ url: string; headers: Record<string, string>; input: string[]; model: string }>
}

/**
 * An OpenAI-compatible endpoint in process. `respond` may replace the answer
 * for a request: a status code, or "hang" to wait until the request is aborted.
 */
export function fakeEndpoint(respond?: (input: string[], attempt: number) => number | "hang" | undefined): FakeEndpoint {
  const requests: FakeEndpoint["requests"] = []
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body) as { input: string[]; model: string }
    requests.push({ url, headers: init.headers, input: body.input, model: body.model })
    const override = respond?.(body.input, requests.length)
    if (override === "hang") {
      return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
    }
    if (typeof override === "number") {
      return { ok: false, status: override, json: async () => ({}), text: async () => `status ${override}` }
    }
    const data = body.input.map((text, index) => ({ index, embedding: fakeVector(text) }))
    return { ok: true, status: 200, json: async () => ({ data: data.reverse() }), text: async () => "" }
  }
  return { fetch, requests }
}
