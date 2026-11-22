import { MAX_BODY_BYTES, parseBatch, replyStatus, toPostHog, type RequestGeo } from "./ingest"

/** The one R2 call used, so the Worker needs no Cloudflare type package to build. */
interface ArchiveBucket {
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>
}

interface Env {
  /**
   * PostHog project API key (a write-only key), set with `wrangler secret put POSTHOG_API_KEY`.
   * Until it is set, accepted batches are only archived.
   */
  POSTHOG_API_KEY?: string
  /** PostHog ingestion host, such as `https://us.i.posthog.com`. */
  POSTHOG_HOST: string
  /** Optional R2 bucket keeping a raw copy of every accepted batch. */
  ARCHIVE?: ArchiveBucket
}

interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

async function readBody(request: Request): Promise<unknown | Response> {
  const declared = Number(request.headers.get("content-length") ?? 0)
  if (declared > MAX_BODY_BYTES) return json(413, { error: "Body too large" })
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) return json(413, { error: "Body too large" })
  try {
    return JSON.parse(text)
  } catch {
    return json(400, { error: "Invalid JSON" })
  }
}

export default {
  async fetch(request: Request, env: Env, context: WaitUntil): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== "/v1/batch") return json(404, { error: "Not found" })
    if (request.method !== "POST") return json(405, { error: "Use POST" })

    const body = await readBody(request)
    if (body instanceof Response) return body
    const batch = parseBatch(body)
    if (typeof batch === "string") return json(400, { error: batch })

    const geo = (request as Request & { cf?: RequestGeo }).cf
    const payload = toPostHog(batch, geo, env.POSTHOG_API_KEY ?? "")

    if (env.ARCHIVE) {
      const day = new Date().toISOString().slice(0, 10)
      const archived = env.ARCHIVE.put(`events/${day}/${batch.batch[0].uuid}.json`, JSON.stringify(payload.batch), {
        httpMetadata: { contentType: "application/json" },
      })
      // Before PostHog is set up the archive is the only copy, so it must land before the batch counts as taken.
      if (!env.POSTHOG_API_KEY) {
        try {
          await archived
          return json(200, { accepted: batch.batch.length })
        } catch {
          return json(503, { error: "Could not store the batch" })
        }
      }
      context.waitUntil(archived.catch(() => undefined))
    } else if (!env.POSTHOG_API_KEY) {
      return json(503, { error: "Not set up yet" })
    }

    let upstream: number
    try {
      const response = await fetch(`${env.POSTHOG_HOST.replace(/\/+$/, "")}/batch/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
      upstream = response.status
    } catch {
      upstream = 503
    }
    const status = replyStatus(upstream)
    return status === 200 ? json(200, { accepted: batch.batch.length }) : json(status, { error: "Upstream refused the batch" })
  },
}
