// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import worker from "../index"
import { geoProperties, parseBatch, replyStatus, toPostHog } from "../ingest"

const NOW = Date.parse("2026-11-22T12:00:00Z")
const INSTALL = "0123456789abcdef0123456789abcdef"

function event(overrides: Record<string, unknown> = {}) {
  return {
    uuid: "0a1b2c3d-1111-4222-8333-444455556666",
    event: "usage.daily",
    timestamp: "2026-11-22T11:59:00.000Z",
    properties: { model: "claude-opus-5-5", outputTokens: 10, wsl: false },
    ...overrides,
  }
}

describe("parseBatch", () => {
  it("accepts a well-formed batch", () => {
    const batch = parseBatch({ installId: INSTALL, batch: [event()] }, NOW)
    expect(batch).toMatchObject({ installId: INSTALL, batch: [{ event: "usage.daily" }] })
  })

  it.each([
    [{ installId: "nope", batch: [event()] }, "Invalid installId"],
    [{ installId: INSTALL, batch: [] }, "batch must hold 1 to 100 events"],
    [{ installId: INSTALL, batch: [event({ uuid: "x" })] }, "Invalid event"],
    [{ installId: INSTALL, batch: [event({ event: "Bad Event" })] }, "Invalid event"],
    [{ installId: INSTALL, batch: [event({ timestamp: "2026-10-01T00:00:00Z" })] }, "Invalid event"],
    [{ installId: INSTALL, batch: [event({ properties: { nested: { a: 1 } } })] }, "Invalid event"],
    [{ installId: INSTALL, batch: [event({ properties: { long: "x".repeat(200) } })] }, "Invalid event"],
    [{ installId: INSTALL, batch: [event({ properties: { $ip: "1.2.3.4" } })] }, "Invalid event"],
  ])("refuses %o", (body, reason) => {
    expect(parseBatch(body, NOW)).toBe(reason)
  })
})

describe("geoProperties", () => {
  it("keeps country, region, continent and timezone, never the city", () => {
    expect(geoProperties({ country: "de", region: "Bavaria", continent: "EU", timezone: "Europe/Berlin", city: "Munich" } as never)).toEqual({
      country: "DE",
      $geoip_country_code: "DE",
      region: "Bavaria",
      $geoip_subdivision_1_name: "Bavaria",
      continent: "EU",
      $geoip_continent_code: "EU",
      $geoip_time_zone: "Europe/Berlin",
    })
    expect(geoProperties(undefined)).toEqual({})
  })
})

describe("toPostHog", () => {
  it("sends anonymous events with the install as distinct id and no IP lookup", () => {
    const batch = parseBatch({ installId: INSTALL, batch: [event()] }, NOW)
    if (typeof batch === "string") throw new Error(batch)
    const payload = toPostHog(batch, { country: "US" }, "phc_key")
    expect(payload.api_key).toBe("phc_key")
    expect(payload.batch[0]).toMatchObject({
      distinct_id: INSTALL,
      properties: { model: "claude-opus-5-5", country: "US", $process_person_profile: false, $geoip_disable: true, $ip: null },
    })
  })
})

describe("replyStatus", () => {
  it("tells the app to drop refused batches and retry the rest", () => {
    expect(replyStatus(200)).toBe(200)
    expect(replyStatus(400)).toBe(422)
    expect(replyStatus(429)).toBe(503)
    expect(replyStatus(500)).toBe(503)
  })
})

describe("worker", () => {
  afterEach(() => vi.unstubAllGlobals())

  const env = { POSTHOG_API_KEY: "phc_key", POSTHOG_HOST: "https://posthog.test/" }
  const context = { waitUntil: vi.fn() }

  function post(body: unknown, cf?: object) {
    const request = new Request("https://telemetry.cogpit.dev/v1/batch", { method: "POST", body: JSON.stringify(body) })
    if (cf) Object.defineProperty(request, "cf", { value: cf })
    return request
  }

  it("forwards a valid batch with the location added", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }))
    vi.stubGlobal("fetch", fetch)
    const response = await worker.fetch(post({ installId: INSTALL, batch: [event({ timestamp: new Date().toISOString() })] }, { country: "FR", city: "Paris" }), env, context)
    expect(response.status).toBe(200)
    const [url, init] = fetch.mock.calls[0] as unknown as [string, { body: string }]
    expect(url).toBe("https://posthog.test/batch/")
    expect(init.body).toContain("\"country\":\"FR\"")
    expect(init.body).not.toContain("Paris")
  })

  it("refuses a bad batch without calling PostHog", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const response = await worker.fetch(post({ installId: "bad", batch: [] }), env, context)
    expect(response.status).toBe(400)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("asks for a retry when PostHog is down", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down") }))
    const response = await worker.fetch(post({ installId: INSTALL, batch: [event({ timestamp: new Date().toISOString() })] }), env, context)
    expect(response.status).toBe(503)
  })

  it("only archives until PostHog is set up", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const put = vi.fn(async () => undefined)
    const body = { installId: INSTALL, batch: [event({ timestamp: new Date().toISOString() })] }
    const archived = await worker.fetch(post(body), { POSTHOG_HOST: env.POSTHOG_HOST, ARCHIVE: { put } }, context)
    expect(archived.status).toBe(200)
    expect(put).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()

    expect((await worker.fetch(post(body), { POSTHOG_HOST: env.POSTHOG_HOST }, context)).status).toBe(503)
    const failing = { put: vi.fn(async () => { throw new Error("r2 down") }) }
    expect((await worker.fetch(post(body), { POSTHOG_HOST: env.POSTHOG_HOST, ARCHIVE: failing }, context)).status).toBe(503)
  })

  it("answers only POST /v1/batch", async () => {
    expect((await worker.fetch(new Request("https://telemetry.cogpit.dev/"), env, context)).status).toBe(404)
    expect((await worker.fetch(new Request("https://telemetry.cogpit.dev/v1/batch"), env, context)).status).toBe(405)
  })
})
