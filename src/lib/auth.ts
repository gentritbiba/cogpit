// ── Network auth utilities ──────────────────────────────────────────────

import { withBase } from "./device"
import { announceGate } from "./gateEvents"
import { announceRefusal } from "./sessionAccessEvents"
import { knownSignIn, rememberSignIn } from "./serverSignIn"
import { MINT_FAILURE_CODES } from "../../shared/contracts/hub"
import { isCogpitEdition, type CogpitEdition, type SignInMode } from "../../shared/contracts/identity"

const LEGACY_TOKEN_KEY = "cogpit-network-token"
const LOCAL_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "0:0:0:0:0:0:0:1",
])

export function isRemoteClient(): boolean {
  const hostname = window.location.hostname.toLowerCase()
  const host = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname
  return !LOCAL_HOSTNAMES.has(host)
}

export function clearToken(): void {
  try {
    localStorage.removeItem(LEGACY_TOKEN_KEY)
    sessionStorage.removeItem(LEGACY_TOKEN_KEY)
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}

// Remove tokens written by older releases as soon as the hardened client
// loads. Session credentials must never be readable by page JavaScript.
if (typeof window !== "undefined") clearToken()

// ── Server handshake (public /api/hello) ────────────────────────────────

/** The pre-authentication facts the renderer needs from `/api/hello`. */
export interface ServerHello {
  edition: CogpitEdition
  signIn: SignInMode
  /** Account sign-in with no accounts yet: the server's first-time setup is open. */
  setupRequired: boolean
}

const PERSONAL_HELLO: ServerHello = { edition: "personal", signIn: "password", setupRequired: false }

let helloPromise: Promise<ServerHello> | null = null

function probeServerHello(): Promise<ServerHello> {
  return fetch("/api/hello", {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "X-Cogpit-Client": "1" },
  })
    .then(async (res) => {
      if (!res.ok) throw new Error(`Hello handshake failed (${res.status})`)
      const data = await res.json() as { edition?: unknown; signIn?: unknown; setupRequired?: unknown }
      const signIn: SignInMode = data.signIn === "account" ? "account" : "password"
      rememberSignIn(signIn)
      return {
        edition: isCogpitEdition(data.edition) ? data.edition : "personal",
        signIn,
        setupRequired: signIn === "account" && data.setupRequired === true,
      }
    })
    .catch(() => {
      helloPromise = null
      return PERSONAL_HELLO
    })
}

/**
 * Resolve the public `/api/hello` handshake — needed BEFORE authentication
 * because a server with account sign-in gates even localhost browsers and may
 * have no accounts to sign in with yet. Fetched once and shared by every
 * consumer (auth gate, login screen, setup screen); a failed probe resolves as
 * personal (the no-op path) without being cached so the next caller retries.
 */
export function getServerHello(): Promise<ServerHello> {
  helloPromise ??= probeServerHello()
  return helloPromise
}

/**
 * Re-run the handshake and replace the cache. Setup state changes the moment
 * the first account is created — by this browser or another one — so the
 * cached answer must be discarded rather than trusted for the session.
 */
export function refreshServerHello(): Promise<ServerHello> {
  helloPromise = probeServerHello()
  return helloPromise
}

/** The server's sign-in alone, from the same shared handshake. */
export function getServerSignIn(): Promise<SignInMode> {
  return getServerHello().then((hello) => hello.signIn)
}

export function __resetServerHelloForTest(): void {
  helloPromise = null
  rememberSignIn(null)
}

export async function checkAuthSession(): Promise<boolean> {
  // Account sign-in authenticates local browsers too; the trusted-local
  // short-circuit only applies while the server signs in (or is assumed to)
  // with the network password.
  if (!isRemoteClient() && knownSignIn() !== "account") return true
  try {
    const response = await fetch("/api/auth/session", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "X-Cogpit-Client": "1" },
    })
    return response.ok
  } catch {
    return false
  }
}

export async function logoutSession(): Promise<void> {
  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "X-Cogpit-Client": "1" },
    })
  } finally {
    clearToken()
  }
}

/** The hub's verdicts on its own proxy attempts that raise the device banner: every failed device token. */
const DEVICE_BANNER_ERRORS: ReadonlySet<string> = new Set(MINT_FAILURE_CODES)

/** {@link authFetch}'s options beyond fetch's own. */
export interface AuthFetchInit extends RequestInit {
  /** Sent without the user asking, such as a hover prefetch. */
  background?: boolean
}

/** Scrub legacy tokens, announce the login requirement, and fail the call. */
function failAuthRequired(): Promise<never> {
  clearToken()
  window.dispatchEvent(new Event("cogpit-auth-required"))
  return Promise.reject(new Error("Authentication required"))
}

/**
 * Shared fetch core for {@link authFetch} and {@link hubFetch}.
 *
 * - Always sends `X-Cogpit-Client: 1` (drive-by-localhost CSRF guard; the hub
 *   requires it on state-changing `/hub/*` requests).
 * - Browser credentials stay in an HttpOnly same-origin cookie. A gated 401
 *   emits `cogpit-auth-required`; JavaScript never reads or attaches the token.
 * - A local 401 while the sign-in is still unknown (the boot hello probe
 *   failed) re-probes once — a server with account sign-in then gates this tab
 *   instead of leaving it permanently on raw errors.
 * - `X-Cogpit-Hub-Error` is the hub's verdict on its own proxy attempt, so only
 *   it raises the connectivity banner. A device that answers 502 from its own
 *   API (an unavailable CLI runtime, a failed approval) is still reachable, and
 *   its reply carries `X-Cogpit-Device` too — status alone would conflate them.
 * - A refused session request announces the caller's access to that session
 *   (see sessionAccessEvents), marked when the request was a background one,
 *   and a request refused behind the server's gate announces the gate (see
 *   gateEvents); neither says anything about being signed in.
 *
 * @param applyBase when true and `input` is a string starting "/api", route it
 *   to the active device via {@link withBase}. `hubFetch` passes false so
 *   hub-scoped calls always target the hub itself.
 */
function requestWithAuth(
  input: RequestInfo | URL,
  init: AuthFetchInit | undefined,
  applyBase: boolean,
): Promise<Response> {
  if (applyBase && typeof input === "string" && input.startsWith("/api")) {
    input = withBase(input)
  }

  const { background = false, ...requestInit } = init ?? {}
  const headers = new Headers(requestInit.headers)
  headers.delete("Authorization")
  headers.set("X-Cogpit-Client", "1")

  return fetch(input, { ...requestInit, headers, credentials: "same-origin" }).then((res) => {
    announceRefusal(res, background)
    announceGate(res)
    if (res.status === 401) {
      // A 401 means "session required" for remote clients always, and for local
      // browsers once the server is known to sign in with accounts (which gate localhost).
      if (isRemoteClient() || knownSignIn() === "account") return failAuthRequired()
      // Unknown sign-in on a local client means the hello probe failed and the
      // password was assumed without being cached — re-probe before trusting
      // the assumption (a failed probe leaves no cache, so this fetches fresh).
      if (knownSignIn() === null) {
        return getServerSignIn().then((signIn) =>
          signIn === "account" ? failAuthRequired() : res,
        )
      }
    }
    if (res.status === 502) {
      // Every verdict the banner cares about is a gateway failure, so nothing
      // outside a 502 needs its headers inspected.
      const hubError = res.headers.get("X-Cogpit-Hub-Error")
      const deviceId = res.headers.get("X-Cogpit-Device")
      if (deviceId && hubError && DEVICE_BANNER_ERRORS.has(hubError)) {
        window.dispatchEvent(
          new CustomEvent("cogpit-device-unreachable", {
            detail: { deviceId, reason: hubError },
          }),
        )
      }
    }
    return res
  })
}

/**
 * Wrapper around fetch that includes the browser session cookie and routes
 * string `/api/*` URLs to the active device. The `X-Cogpit-Client` header is
 * always present as the mutation-source guard.
 */
export function authFetch(input: RequestInfo | URL, init?: AuthFetchInit): Promise<Response> {
  return requestWithAuth(input, init, true)
}

/** POST (or PUT via `init.method`) a JSON body through {@link authFetch}. */
export function jsonFetch(input: string, body: unknown, init: RequestInit = {}): Promise<Response> {
  return authFetch(input, {
    method: "POST",
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
    body: JSON.stringify(body),
  })
}

/**
 * Like {@link authFetch} but never applies the device prefix — for hub-scoped
 * call sites (device management, hub network info) that must always target the
 * hub itself regardless of the active device.
 */
export function hubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return requestWithAuth(input, init, false)
}

/**
 * Route URLs to the active device. EventSource, images, and WebSockets receive
 * the same-origin HttpOnly cookie automatically, so credentials never enter
 * query strings.
 */
export function authUrl(url: string): string {
  return withBase(url)
}
