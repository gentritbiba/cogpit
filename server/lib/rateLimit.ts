import type { IncomingMessage } from "node:http"

/**
 * Attempt throttling for the endpoints that check a password.
 *
 * State is module-level and process-wide on purpose: a per-request limiter
 * would reset on every call and throttle nothing.
 */

interface RateLimitEntry {
  count: number
  resetAt: number
}

const rateLimitMap = new Map<string, RateLimitEntry>()
const RATE_LIMIT_WINDOW_MS = 60_000  // 1 minute
const RATE_LIMIT_MAX_ATTEMPTS = 5    // 5 attempts per window
const RATE_LIMIT_CONNECTOR_MAX_ATTEMPTS = 30

function getRateLimitKey(req: IncomingMessage): string {
  const forwarded = req.headers?.["cf-connecting-ip"] ?? req.headers?.["x-forwarded-for"]
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded
  const client = value?.split(",")[0]?.trim()
  return client ? `client:${client.slice(0, 128)}` : `socket:${req.socket.remoteAddress || "unknown"}`
}

function consumeRateLimit(key: string, maxAttempts: number, now: number): boolean {
  const entry = rateLimitMap.get(key)
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return false
  }

  entry.count += 1
  return entry.count > maxAttempts
}

export function isRateLimited(req: IncomingMessage): boolean {
  const now = Date.now()
  const clientKey = getRateLimitKey(req)
  const socketKey = `socket:${req.socket.remoteAddress || "unknown"}`

  const clientLimited = consumeRateLimit(clientKey, RATE_LIMIT_MAX_ATTEMPTS, now)
  if (clientKey === socketKey) return clientLimited

  // Reverse proxies multiplex many real clients over one connector. Keep a
  // higher connector-wide ceiling so spoofed forwarding headers cannot turn
  // into unlimited password work, without letting one IP lock everybody out.
  const connectorLimited = consumeRateLimit(socketKey, RATE_LIMIT_CONNECTOR_MAX_ATTEMPTS, now)
  return clientLimited || connectorLimited
}

// Periodically clean up expired entries (unref so build process can exit)
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(key)
  }
}, 60_000).unref()
