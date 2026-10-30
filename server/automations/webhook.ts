import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import type { IncomingHttpHeaders } from "node:http"
import type { AutomationWebhook } from "../../shared/contracts/automations"

/**
 * Webhook delivery authentication: an HMAC-SHA256 signature by a secret only
 * the task's owner was shown. A valid signature admits the delivery as input
 * to the task's next run; it carries none of the owner's authority.
 */

/** How far a `cogpit` delivery's timestamp may stray from the server's clock. */
export const TIMESTAMP_TOLERANCE_MS = 5 * 60_000
const DELIVERY_ID = /^[A-Za-z0-9_.:-]{1,128}$/

export function newWebhookSecret(): string { return `whsec_${randomBytes(32).toString("hex")}` }

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

function signatureMatches(given: string | undefined, key: string, payload: Buffer): string | null {
  const hex = given?.startsWith("sha256=") ? given.slice(7) : null
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) return null
  const expected = createHmac("sha256", key).update(payload).digest()
  return timingSafeEqual(expected, Buffer.from(hex, "hex")) ? hex.toLowerCase() : null
}

export type VerifiedDelivery = { ok: true; deliveryId: string } | { ok: false; status: 400 | 401; error: string }

/**
 * Checks a delivery against every live secret of its task. `deliveryId` keys
 * replay dedupe, so it is always signed: a `cogpit` delivery signs its id with
 * the timestamp and body, and a `github` one, whose delivery header GitHub
 * leaves unsigned, is identified by its body signature.
 */
export function verifyDelivery(scheme: AutomationWebhook["scheme"], headers: IncomingHttpHeaders, body: Buffer, secrets: readonly string[], now: number): VerifiedDelivery {
  let signature: string | null = null
  let deliveryId: string | undefined
  if (scheme === "cogpit") {
    const stamp = header(headers, "x-cogpit-timestamp")
    if (!stamp || !/^\d{1,12}$/.test(stamp)) return { ok: false, status: 400, error: "X-Cogpit-Timestamp is required" }
    if (Math.abs(now - Number(stamp) * 1000) > TIMESTAMP_TOLERANCE_MS) return { ok: false, status: 401, error: "The delivery is too old or from the future" }
    deliveryId = header(headers, "x-cogpit-delivery")
    if (!deliveryId || !DELIVERY_ID.test(deliveryId)) return { ok: false, status: 400, error: "X-Cogpit-Delivery is required" }
    const payload = Buffer.concat([Buffer.from(`${stamp}.${deliveryId}.`), body])
    for (const key of secrets) signature ??= signatureMatches(header(headers, "x-cogpit-signature"), key, payload)
  } else {
    for (const key of secrets) signature ??= signatureMatches(header(headers, "x-hub-signature-256"), key, body)
    deliveryId = signature ? `sig-${signature}` : undefined
  }
  if (!signature || !deliveryId) return { ok: false, status: 401, error: "The signature does not match" }
  return { ok: true, deliveryId }
}
