import type { SignInMode } from "../../shared/contracts/identity"

// How this browser's own server said its sign-in works at the public
// handshake, kept apart from the fetch plumbing that learns it so storage can
// ask without it.

let known: SignInMode | null = null

/** The sign-in the handshake reported, or null while it has not (or could not). */
export function knownSignIn(): SignInMode | null {
  return known
}

export function rememberSignIn(signIn: SignInMode | null): void {
  known = signIn
}
