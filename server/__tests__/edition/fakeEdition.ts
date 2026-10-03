import type { IncomingMessage, ServerResponse } from "node:http"
import { __resetEditionForTest, installEdition, PERSONAL_EDITION, type EditionAuth, type EditionModule } from "../../edition"
import type { NextFn } from "../../http"
import { setRequestAuthentication } from "../../requestAuthentication"
import { setRequestPrincipal } from "../../requestPrincipal"
import { getRequestSessionToken, getSessionPrincipal, validateSessionToken } from "../../security"
import { fakeEditionAuth } from "./fakeAuth"

/**
 * An edition without any package: personal edition's hooks with `hooks` in
 * their place, so core's side of the seam runs against fakes.
 */
export function installFakeEdition<Hooks extends Partial<EditionModule>>(hooks: Hooks): EditionModule & Hooks {
  __resetEditionForTest()
  const edition = { ...PERSONAL_EDITION, edition: "team" as const, ...hooks }
  installEdition(edition)
  return edition
}

/**
 * Sign a request in from the session token it carries, as an edition that
 * owns sign-in does once it checked the token; a request without a valid one
 * is refused with 401.
 */
export function signInByToken(req: IncomingMessage, res: ServerResponse, next: NextFn): void {
  const token = getRequestSessionToken(req)
  const principal = token && validateSessionToken(token) ? getSessionPrincipal(token) : null
  if (!token || !principal) {
    res.statusCode = 401
    res.end()
    return
  }
  setRequestPrincipal(req, principal)
  setRequestAuthentication(req, { kind: "session", token, principal })
  next()
}

/**
 * Core's own branches for an edition that signs accounts in, without any
 * package: `fakeEditionAuth()` with `overrides` installed while every other
 * hook answers as personal edition does. Returns the auth so a test can steer it.
 */
export function useAccountSignIn(overrides: Partial<EditionAuth> = {}): EditionAuth {
  return installFakeEdition({ auth: { ...fakeEditionAuth(), ...overrides } }).auth
}
