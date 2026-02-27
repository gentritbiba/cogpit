import type { IncomingMessage, ServerResponse } from "node:http"
import { timingSafeEqual, randomBytes, createHash } from "node:crypto"
import { getConfig } from "./config"

// ── Shared types (duplicated here to avoid circular imports) ─────────

export type NextFn = (err?: unknown) => void

// ── Network auth helpers ─────────────────────────────────────────────

const LOCAL_ADDRS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])

export function isLocalRequest(req: IncomingMessage): boolean {
  return LOCAL_ADDRS.has(req.socket.remoteAddress || "")
}

export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA)
    return false
  }
  return timingSafeEqual(bufA, bufB)
}

// ── Session token system ────────────────────────────────────────────

interface SessionInfo {
  createdAt: number
  ip: string
  userAgent: string
  lastActivity: number
}

const activeSessions = new Map<string, SessionInfo>()
const SESSION_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

export function createSessionToken(ip: string, userAgent?: string): string {
  const token = randomBytes(32).toString("hex")
  const now = Date.now()
  activeSessions.set(token, { createdAt: now, ip, userAgent: userAgent || "", lastActivity: now })
  return token
}

export function validateSessionToken(token: string): boolean {
  const session = activeSessions.get(token)
  if (!session) return false
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    activeSessions.delete(token)
    return false
  }
  session.lastActivity = Date.now()
  return true
}

export function revokeAllSessions(): void {
  activeSessions.clear()
}

export function getConnectedDevices(): Array<{ ip: string; userAgent: string; deviceName: string; connectedAt: number; lastActivity: number }> {
  const now = Date.now()
  const devices: Array<{ ip: string; userAgent: string; deviceName: string; connectedAt: number; lastActivity: number }> = []
  for (const [, session] of activeSessions) {
    if (now - session.createdAt > SESSION_TTL_MS) continue
    devices.push({
      ip: session.ip.replace(/^::ffff:/, ""),
      userAgent: session.userAgent,
      deviceName: parseDeviceName(session.userAgent),
      connectedAt: session.createdAt,
      lastActivity: session.lastActivity,
    })
  }
  return devices
}

function parseDeviceName(ua: string): string {
  if (!ua) return "Unknown device"
  if (/iPhone/.test(ua)) return "iPhone"
  if (/iPad/.test(ua)) return "iPad"
  if (/Macintosh|Mac OS/.test(ua)) return "Mac"
  if (/Windows/.test(ua)) return "Windows PC"
  if (/Android/.test(ua)) {
    const match = ua.match(/;\s*([^;)]+)\s*Build\//)
    if (match) return match[1].trim()
    return "Android device"
  }
  if (/Linux/.test(ua)) return "Linux"
  return "Unknown device"
}

// Clean up expired sessions periodically (unref so build process can exit)
setInterval(() => {
  const now = Date.now()
  for (const [token, session] of activeSessions) {
    if (now - session.createdAt > SESSION_TTL_MS) activeSessions.delete(token)
  }
}, 60_000).unref()

// ── Password hashing ────────────────────────────────────────────────

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex")
  const hash = createHash("sha256").update(salt + password).digest("hex")
  return `${salt}:${hash}`
}

export function verifyPassword(password: string, stored: string): boolean {
  if (!stored.includes(":")) {
    return safeCompare(password, stored)
  }
  const [salt, hash] = stored.split(":")
  const candidate = createHash("sha256").update(salt + password).digest("hex")
  return safeCompare(candidate, hash)
}

// ── Password validation ─────────────────────────────────────────────

export const MIN_PASSWORD_LENGTH = 12

export function validatePasswordStrength(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`
  }
  return null
}

// ── Security headers middleware ──────────────────────────────────────

export function securityHeaders(_req: IncomingMessage, res: ServerResponse, next: NextFn): void {
  res.setHeader("X-Content-Type-Options", "nosniff")
  res.setHeader("X-Frame-Options", "DENY")
  res.setHeader("Referrer-Policy", "no-referrer")
  res.setHeader("Permissions-Policy", "camera=(), microphone=(self), geolocation=()")
  res.setHeader("X-XSS-Protection", "1; mode=block")
  res.setHeader("Cross-Origin-Embedder-Policy", "credentialless")
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin")
  next()
}

// ── Body size limit ─────────────────────────────────────────────────

const MAX_BODY_SIZE = 5 * 1024 * 1024 // 5MB

export function bodySizeLimit(req: IncomingMessage, res: ServerResponse, next: NextFn): void {
  if (req.method !== "POST" && req.method !== "PUT" && req.method !== "PATCH") return next()

  let size = 0
  const contentLength = parseInt(req.headers["content-length"] || "", 10)
  if (contentLength > MAX_BODY_SIZE) {
    res.statusCode = 413
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ error: "Request body too large" }))
    return
  }

  const origOn = req.on.bind(req)
  req.on = function (event: string, listener: (...args: unknown[]) => void) {
    if (event === "data") {
      const wrapped = (chunk: Buffer | string) => {
        size += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length
        if (size > MAX_BODY_SIZE) {
          res.statusCode = 413
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ error: "Request body too large" }))
          req.destroy()
          return
        }
        ;(listener as (chunk: Buffer | string) => void)(chunk)
      }
      return origOn(event, wrapped)
    }
    return origOn(event, listener)
  } as typeof req.on

  next()
}

// ── Auth middleware ──────────────────────────────────────────────────

const PUBLIC_PATHS = new Set(["/api/auth/verify"])

function isPublicPath(url: string): boolean {
  if (PUBLIC_PATHS.has(url.split("?")[0])) return true
  if (!url.startsWith("/api/") && !url.startsWith("/__pty")) return true
  return false
}

export function authMiddleware(req: IncomingMessage, res: ServerResponse, next: NextFn): void {
  if (isLocalRequest(req)) return next()
  if (isPublicPath(req.url || "/")) return next()

  const config = getConfig()
  if (!config?.networkAccess || !config?.networkPassword) {
    res.statusCode = 403
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ error: "Network access is disabled" }))
    return
  }

  const authHeader = req.headers.authorization
  let token: string | null = null
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7)
  } else {
    const url = new URL(req.url || "/", "http://localhost")
    token = url.searchParams.get("token")
  }

  if (!token || !validateSessionToken(token)) {
    res.statusCode = 401
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ error: "Authentication required" }))
    return
  }

  next()
}
