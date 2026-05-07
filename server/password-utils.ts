import { timingSafeEqual, randomBytes, createHash } from "node:crypto"

// Hash format: "$sha256$<32-hex-salt>:<64-hex-sha256>"
// This prefix makes hashed values unambiguously distinguishable from plaintext,
// even if the plaintext contains a colon.
export const HASH_PREFIX = "$sha256$"

/**
 * Returns true if the stored value is already in hashed form.
 * Handles both the current prefixed format ($sha256$...) and the legacy
 * unprefixed format (<salt>:<hash>) produced by earlier versions.
 */
export function isPasswordHashed(stored: string): boolean {
  if (stored.startsWith(HASH_PREFIX)) return true
  // Legacy detection: 32-char hex salt + ":" + 64-char hex sha256
  const colonIdx = stored.indexOf(":")
  if (colonIdx === 32) {
    const salt = stored.slice(0, 32)
    const hash = stored.slice(33)
    return /^[0-9a-f]{32}$/.test(salt) && /^[0-9a-f]{64}$/.test(hash)
  }
  return false
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex") // 32 hex chars
  const hash = createHash("sha256").update(salt + password).digest("hex") // 64 hex chars
  return `${HASH_PREFIX}${salt}:${hash}`
}

export function verifyPassword(password: string, stored: string): boolean {
  if (stored.startsWith(HASH_PREFIX)) {
    // Current format: $sha256$<salt>:<hash>
    const inner = stored.slice(HASH_PREFIX.length)
    const colonIdx = inner.indexOf(":")
    if (colonIdx === -1) return false
    const salt = inner.slice(0, colonIdx)
    const hash = inner.slice(colonIdx + 1)
    const candidate = createHash("sha256").update(salt + password).digest("hex")
    const bufA = Buffer.from(candidate)
    const bufB = Buffer.from(hash)
    if (bufA.length !== bufB.length) { timingSafeEqual(bufA, bufA); return false }
    return timingSafeEqual(bufA, bufB)
  }
  if (stored.includes(":")) {
    // Legacy format: <salt>:<hash> (no prefix, produced by older versions)
    const colonIdx = stored.indexOf(":")
    const salt = stored.slice(0, colonIdx)
    const hash = stored.slice(colonIdx + 1)
    const candidate = createHash("sha256").update(salt + password).digest("hex")
    const bufA = Buffer.from(candidate)
    const bufB = Buffer.from(hash)
    if (bufA.length !== bufB.length) { timingSafeEqual(bufA, bufA); return false }
    return timingSafeEqual(bufA, bufB)
  }
  // Plaintext fallback — only reached for configs written before any hashing existed
  const bufA = Buffer.from(password)
  const bufB = Buffer.from(stored)
  if (bufA.length !== bufB.length) { timingSafeEqual(bufA, bufA); return false }
  return timingSafeEqual(bufA, bufB)
}
