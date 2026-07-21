import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto"

// New passwords use a versioned, memory-hard format. The previous salted
// SHA-256 formats remain readable so existing config files keep working.
const HASH_PREFIX = "$scrypt$"
const LEGACY_SHA256_PREFIX = "$sha256$"
const SCRYPT_COST = 16_384
const SCRYPT_BLOCK_SIZE = 8
// OWASP's 16 MiB scrypt profile pairs N=2^14 and r=8 with p=5. This
// preserves a modest desktop memory footprint while meeting its work floor.
const SCRYPT_PARALLELISM = 5
const SCRYPT_KEY_LENGTH = 64
const SCRYPT_MAX_MEMORY = 32 * 1024 * 1024
const HEX_SALT_PATTERN = /^[0-9a-f]{32}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const SCRYPT_KEY_PATTERN = /^[0-9a-f]{128}$/

interface ScryptHash {
  salt: string
  hash: string
}

interface LegacySha256Hash {
  salt: string
  hash: string
}

function parseScryptHash(stored: string): ScryptHash | null {
  const parts = stored.split("$")
  if (
    parts.length !== 7
    || parts[0] !== ""
    || parts[1] !== "scrypt"
    || parts[2] !== String(SCRYPT_COST)
    || parts[3] !== String(SCRYPT_BLOCK_SIZE)
    || parts[4] !== String(SCRYPT_PARALLELISM)
    || !HEX_SALT_PATTERN.test(parts[5])
    || !SCRYPT_KEY_PATTERN.test(parts[6])
  ) return null

  return { salt: parts[5], hash: parts[6] }
}

function parseLegacySha256Hash(stored: string): LegacySha256Hash | null {
  const inner = stored.startsWith(LEGACY_SHA256_PREFIX)
    ? stored.slice(LEGACY_SHA256_PREFIX.length)
    : stored
  const parts = inner.split(":")
  if (
    parts.length !== 2
    || !HEX_SALT_PATTERN.test(parts[0])
    || !SHA256_PATTERN.test(parts[1])
  ) return null

  return { salt: parts[0], hash: parts[1] }
}

function safeCompareBuffers(actual: Buffer, expected: Buffer): boolean {
  if (actual.length !== expected.length) {
    timingSafeEqual(actual, actual)
    return false
  }
  return timingSafeEqual(actual, expected)
}

/** Return true for every password format Cogpit can verify. */
export function isPasswordHashed(stored: string): boolean {
  return parseScryptHash(stored) !== null || parseLegacySha256Hash(stored) !== null
}

/** A versioned value that cannot be parsed must never be treated as plaintext. */
export function isMalformedPasswordHash(stored: string): boolean {
  const hasVersionedPrefix = stored.startsWith(HASH_PREFIX) || stored.startsWith(LEGACY_SHA256_PREFIX)
  return hasVersionedPrefix && !isPasswordHashed(stored)
}

/** Successful legacy/plaintext verification should be upgraded to current scrypt. */
export function needsPasswordRehash(stored: string): boolean {
  return parseScryptHash(stored) === null
}

/** Hash a password using bounded scrypt parameters encoded into the value. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex")
  const hash = scryptSync(password, Buffer.from(salt, "hex"), SCRYPT_KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELISM,
    maxmem: SCRYPT_MAX_MEMORY,
  }).toString("hex")
  return `${HASH_PREFIX}${SCRYPT_COST}$${SCRYPT_BLOCK_SIZE}$${SCRYPT_PARALLELISM}$${salt}$${hash}`
}

/** Verify current scrypt hashes plus both historical SHA-256/plaintext formats. */
export function verifyPassword(password: string, stored: string): boolean {
  const scryptHash = parseScryptHash(stored)
  if (scryptHash) {
    const candidate = scryptSync(password, Buffer.from(scryptHash.salt, "hex"), SCRYPT_KEY_LENGTH, {
      N: SCRYPT_COST,
      r: SCRYPT_BLOCK_SIZE,
      p: SCRYPT_PARALLELISM,
      maxmem: SCRYPT_MAX_MEMORY,
    })
    return safeCompareBuffers(candidate, Buffer.from(scryptHash.hash, "hex"))
  }

  const legacyHash = parseLegacySha256Hash(stored)
  if (legacyHash) {
    const candidate = createHash("sha256")
      .update(legacyHash.salt + password)
      .digest("hex")
    return safeCompareBuffers(Buffer.from(candidate), Buffer.from(legacyHash.hash))
  }

  if (isMalformedPasswordHash(stored)) return false

  // Plaintext fallback is retained only for configs written before hashing.
  return safeCompareBuffers(Buffer.from(password), Buffer.from(stored))
}

/** Async verifier for the public auth path so scrypt never blocks the event loop. */
export async function verifyPasswordAsync(password: string, stored: string): Promise<boolean> {
  const scryptHash = parseScryptHash(stored)
  if (!scryptHash) return verifyPassword(password, stored)

  const candidate = await new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      Buffer.from(scryptHash.salt, "hex"),
      SCRYPT_KEY_LENGTH,
      {
        N: SCRYPT_COST,
        r: SCRYPT_BLOCK_SIZE,
        p: SCRYPT_PARALLELISM,
        maxmem: SCRYPT_MAX_MEMORY,
      },
      (error, derivedKey) => error ? reject(error) : resolve(derivedKey),
    )
  })
  return safeCompareBuffers(candidate, Buffer.from(scryptHash.hash, "hex"))
}
