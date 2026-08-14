import { randomBytes, timingSafeEqual } from "node:crypto"

export const BOOTSTRAP_TOKEN_HEADER = "x-cogpit-bootstrap-token"
export const MIN_BOOTSTRAP_TOKEN_LENGTH = 32
const MAX_BOOTSTRAP_TOKEN_LENGTH = 256
const SAFE_CONFIGURED_TOKEN = /^[\x21-\x7e]+$/

let bootstrapToken: string | null = null

function equalSecret(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) {
    timingSafeEqual(left, left)
    return false
  }
  return timingSafeEqual(left, right)
}

/**
 * Create the process-local credential for the zero-user bootstrap window.
 * An operator-provided token makes headless/curl setup deterministic; generated
 * tokens rotate on every zero-user restart and are intentionally never stored.
 */
export function initializeBootstrapToken(
  users: number,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (users > 0) {
    bootstrapToken = null
    return null
  }

  const configured = env.COGPIT_BOOTSTRAP_TOKEN
  if (configured && (
    configured.length < MIN_BOOTSTRAP_TOKEN_LENGTH
    || configured.length > MAX_BOOTSTRAP_TOKEN_LENGTH
    || !SAFE_CONFIGURED_TOKEN.test(configured)
  )) {
    throw new Error(
      `COGPIT_BOOTSTRAP_TOKEN must be ${MIN_BOOTSTRAP_TOKEN_LENGTH}–${MAX_BOOTSTRAP_TOKEN_LENGTH} printable non-space ASCII characters`,
    )
  }
  bootstrapToken = configured || randomBytes(32).toString("base64url")
  return bootstrapToken
}

export function getBootstrapToken(): string | null {
  return bootstrapToken
}

export function verifyBootstrapToken(candidate: string | string[] | undefined): boolean {
  const value = Array.isArray(candidate) ? candidate[0] : candidate
  return bootstrapToken !== null && typeof value === "string" && equalSecret(value, bootstrapToken)
}

/** Clear only after the first user was durably created. */
export function consumeBootstrapToken(): void {
  bootstrapToken = null
}

export function __resetBootstrapTokenForTest(): void {
  bootstrapToken = null
}
