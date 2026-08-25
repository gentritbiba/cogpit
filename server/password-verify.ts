import { verifyPasswordAsync, hashPassword } from "./helpers"

const MAX_CONCURRENT_PASSWORD_VERIFICATIONS = 2
let activePasswordVerifications = 0

/**
 * Scrypt verification for public login paths, capped so a burst of guesses
 * cannot saturate the thread pool. Every caller shares this one budget.
 */
export async function verifyRemotePassword(
  password: string,
  stored: string,
): Promise<"valid" | "invalid" | "busy"> {
  if (activePasswordVerifications >= MAX_CONCURRENT_PASSWORD_VERIFICATIONS) return "busy"
  activePasswordVerifications += 1
  try {
    return await verifyPasswordAsync(password, stored) ? "valid" : "invalid"
  } finally {
    activePasswordVerifications -= 1
  }
}

// Logins for unknown users verify against this hash so both outcomes cost one
// scrypt derivation and response timing cannot enumerate usernames. Computed on
// first use: hashing at import time would tax every boot, including personal
// edition, which never reaches this path.
let dummyHash: string | null = null

export function getDummyHash(): string {
  dummyHash ??= hashPassword("cogpit-dummy-timing-pad")
  return dummyHash
}
