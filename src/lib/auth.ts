// ── Network auth utilities ──────────────────────────────────────────────

import { withBase } from "./device"
import type { CogpitEdition } from "../../shared/contracts/team"

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

// ── Server edition (public /api/hello handshake) ────────────────────────

let editionPromise: Promise<CogpitEdition> | null = null
let knownEdition: CogpitEdition | null = null

/**
 * Resolve the server edition from the public `/api/hello` handshake — needed
 * BEFORE authentication because a team server gates even localhost browsers.
 * Fetched once and shared by every consumer (auth gate + login screen); a
 * failed probe resolves "personal" (the no-op path) without being cached so
 * the next caller retries.
 */
export function getServerEdition(): Promise<CogpitEdition> {
  editionPromise ??= fetch("/api/hello", {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "X-Cogpit-Client": "1" },
  })
    .then(async (res) => {
      if (!res.ok) throw new Error(`Hello handshake failed (${res.status})`)
      const data = await res.json() as { edition?: unknown }
      knownEdition = data.edition === "team" ? "team" : "personal"
      return knownEdition
    })
    .catch(() => {
      editionPromise = null
      return "personal" as const
    })
  return editionPromise
}

export function __resetServerEditionForTest(): void {
  editionPromise = null
  knownEdition = null
}

export async function checkAuthSession(): Promise<boolean> {
  // Team edition authenticates local browsers too; the trusted-local
  // short-circuit only applies while the server is (or is assumed) personal.
  if (!isRemoteClient() && knownEdition !== "team") return true
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
 * - A local 401 while the edition is still unknown (the boot hello probe
 *   failed) re-probes once — a team server then gates this tab instead of
 *   leaving it permanently on raw errors.
 * - A `502` carrying `X-Cogpit-Device` means the hub could not reach that remote
 *   device; dispatch `cogpit-device-unreachable` (banner signal) and still
 *   return the response.
 *
 * @param applyBase when true and `input` is a string starting "/api", route it
 *   to the active device via {@link withBase}. `hubFetch` passes false so
 *   hub-scoped calls always target the hub itself.
 */
function requestWithAuth(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  applyBase: boolean,
): Promise<Response> {
  if (applyBase && typeof input === "string" && input.startsWith("/api")) {
    input = withBase(input)
  }

  const headers = new Headers(init?.headers)
  headers.delete("Authorization")
  headers.set("X-Cogpit-Client", "1")

  return fetch(input, { ...init, headers, credentials: "same-origin" }).then((res) => {
    if (res.status === 401) {
      // A 401 means "session required" for remote clients always, and for local
      // browsers once the server is known to be team edition (team gates localhost).
      if (isRemoteClient() || knownEdition === "team") return failAuthRequired()
      // Unknown edition on a local client means the hello probe failed and
      // "personal" was assumed without being cached — re-probe before trusting
      // the assumption (a failed probe leaves no cache, so this fetches fresh).
      if (knownEdition === null) {
        return getServerEdition().then((edition) =>
          edition === "team" ? failAuthRequired() : res,
        )
      }
    }
    if (res.status === 502) {
      const deviceId = res.headers.get("X-Cogpit-Device")
      if (deviceId) {
        window.dispatchEvent(
          new CustomEvent("cogpit-device-unreachable", { detail: { deviceId } }),
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
export function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return requestWithAuth(input, init, true)
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
