/**
 * What the ingest Worker accepts from a Cogpit server, and what it forwards.
 *
 * The app sends its own small format rather than PostHog's, so the backend can
 * change without an app release. The Worker checks every field, adds a coarse
 * location (country, region, continent, timezone) from Cloudflare's view of
 * the request, and never stores or forwards the IP address itself.
 */

export type Scalar = string | number | boolean

export interface IncomingEvent {
  uuid: string
  event: string
  timestamp: string
  properties: Record<string, Scalar>
}

export interface IncomingBatch {
  installId: string
  batch: IncomingEvent[]
}

/** The parts of Cloudflare's `request.cf` used here. City is left out on purpose. */
export interface RequestGeo {
  country?: string
  region?: string
  regionCode?: string
  continent?: string
  timezone?: string
}

export const MAX_BODY_BYTES = 512 * 1024
const MAX_EVENTS = 100
const MAX_PROPERTIES = 40
const MAX_STRING = 128
const DAY_MS = 24 * 60 * 60 * 1000

const INSTALL_ID = /^[0-9a-f]{32}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const EVENT = /^[a-z][a-z0-9_.]{0,63}$/
const KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseProperties(value: unknown): Record<string, Scalar> | null {
  if (!isRecord(value)) return null
  const entries = Object.entries(value)
  if (entries.length > MAX_PROPERTIES) return null
  const properties: Record<string, Scalar> = {}
  for (const [key, item] of entries) {
    if (!KEY.test(key)) return null
    if (typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) properties[key] = item
    else if (typeof item === "string" && item.length <= MAX_STRING) properties[key] = item
    else return null
  }
  return properties
}

function parseEvent(value: unknown, now: number): IncomingEvent | null {
  if (!isRecord(value)) return null
  const { uuid, event, timestamp } = value
  if (typeof uuid !== "string" || !UUID.test(uuid)) return null
  if (typeof event !== "string" || !EVENT.test(event)) return null
  if (typeof timestamp !== "string") return null
  const at = Date.parse(timestamp)
  // Usage for a finished day is stamped at its end and may wait a week to be sent.
  if (!Number.isFinite(at) || at < now - 10 * DAY_MS || at > now + DAY_MS) return null
  const properties = parseProperties(value.properties)
  if (!properties) return null
  return { uuid, event, timestamp: new Date(at).toISOString(), properties }
}

/** The batch, or a reason it is refused. One bad event refuses the whole batch. */
export function parseBatch(body: unknown, now = Date.now()): IncomingBatch | string {
  if (!isRecord(body)) return "Body must be a JSON object"
  const { installId, batch } = body
  if (typeof installId !== "string" || !INSTALL_ID.test(installId)) return "Invalid installId"
  if (!Array.isArray(batch) || batch.length === 0 || batch.length > MAX_EVENTS) return `batch must hold 1 to ${MAX_EVENTS} events`
  const events: IncomingEvent[] = []
  for (const item of batch) {
    const event = parseEvent(item, now)
    if (!event) return "Invalid event"
    events.push(event)
  }
  return { installId, batch: events }
}

function code(value: string | undefined, length: number): string | undefined {
  return value && value.length === length && /^[A-Z0-9]+$/i.test(value) ? value.toUpperCase() : undefined
}

function label(value: string | undefined): string | undefined {
  return value && value.length <= MAX_STRING ? value : undefined
}

/** Location properties for every event, in Cogpit's names and the ones PostHog's maps read. */
export function geoProperties(geo: RequestGeo | undefined): Record<string, string> {
  const country = code(geo?.country, 2)
  const continent = code(geo?.continent, 2)
  const region = label(geo?.region)
  const timezone = label(geo?.timezone)
  return {
    ...(country ? { country, $geoip_country_code: country } : {}),
    ...(region ? { region, $geoip_subdivision_1_name: region } : {}),
    ...(continent ? { continent, $geoip_continent_code: continent } : {}),
    ...(timezone ? { $geoip_time_zone: timezone } : {}),
  }
}

export interface PostHogBatch {
  api_key: string
  batch: Array<{
    uuid: string
    event: string
    timestamp: string
    distinct_id: string
    properties: Record<string, Scalar | null>
  }>
}

/**
 * PostHog's batch format. Events are anonymous (no person profile), and its own
 * IP lookup is off: the request PostHog sees comes from this Worker, and the
 * location above is already the person's.
 */
export function toPostHog(batch: IncomingBatch, geo: RequestGeo | undefined, apiKey: string): PostHogBatch {
  const location = geoProperties(geo)
  return {
    api_key: apiKey,
    batch: batch.batch.map((event) => ({
      uuid: event.uuid,
      event: event.event,
      timestamp: event.timestamp,
      distinct_id: batch.installId,
      properties: {
        ...event.properties,
        ...location,
        installId: batch.installId,
        $process_person_profile: false,
        $geoip_disable: true,
        $ip: null,
        $lib: "cogpit",
      },
    })),
  }
}

/** How the Worker answers the app once PostHog has answered it. A refused batch is never retried. */
export function replyStatus(upstream: number): number {
  if (upstream >= 200 && upstream < 300) return 200
  if (upstream >= 400 && upstream < 500 && upstream !== 408 && upstream !== 429) return 422
  return 503
}
