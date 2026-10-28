/** The Slack Web API, with Slack's rate limits honoured. Tokens go in the header only, never in a URL or log. */

export class SlackApiError extends Error {
  constructor(readonly method: string, readonly code: string) {
    super(`Slack ${method} failed: ${code}`)
  }
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>

export interface SlackApiOptions {
  fetch?: FetchLike
  sleep?: (ms: number) => Promise<void>
  /** Retries after a 429 before giving up. */
  retries?: number
}

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export type SlackCall = (method: string, body?: Record<string, unknown>) => Promise<Record<string, unknown>>

export function slackApi(token: string, { fetch: fetchImpl = fetch as unknown as FetchLike, sleep = sleepFor, retries = 3 }: SlackApiOptions = {}): SlackCall {
  return async (method, body = {}) => {
    for (let attempt = 0; ; attempt++) {
      const response = await fetchImpl(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      })
      if (response.status === 429) {
        if (attempt >= retries) throw new SlackApiError(method, "ratelimited")
        const seconds = Number(response.headers.get("retry-after"))
        await sleep((Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 120) : 2 ** attempt) * 1000)
        continue
      }
      const result = (await response.json()) as Record<string, unknown>
      if (result.ok !== true) throw new SlackApiError(method, typeof result.error === "string" ? result.error : `http_${response.status}`)
      return result
    }
  }
}
