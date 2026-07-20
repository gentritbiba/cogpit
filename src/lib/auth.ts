// ── Network auth utilities ──────────────────────────────────────────────

import { withBase } from "./device"

const TOKEN_KEY = "cogpit-network-token"

export function isRemoteClient(): boolean {
  const host = window.location.hostname
  return host !== "localhost" && host !== "127.0.0.1" && host !== "::1"
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
  window.dispatchEvent(new Event("cogpit-auth-changed"))
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

/**
 * Shared fetch core for {@link authFetch} and {@link hubFetch}.
 *
 * - Always sends `X-Cogpit-Client: 1` (drive-by-localhost CSRF guard; the hub
 *   requires it on state-changing `/hub/*` requests).
 * - Remote clients inject the bearer token and treat a 401 as "re-auth" (clear
 *   token + `cogpit-auth-required`). Local clients pass responses through
 *   untouched, exactly as before.
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
  const remote = isRemoteClient()

  if (applyBase && typeof input === "string" && input.startsWith("/api")) {
    input = withBase(input)
  }

  const headers = new Headers(init?.headers)
  headers.set("X-Cogpit-Client", "1")

  if (remote) {
    const token = getToken()
    if (!token) {
      window.dispatchEvent(new Event("cogpit-auth-required"))
      return Promise.reject(new Error("Authentication required"))
    }
    headers.set("Authorization", `Bearer ${token}`)
  }

  return fetch(input, { ...init, headers }).then((res) => {
    if (remote && res.status === 401) {
      clearToken()
      window.dispatchEvent(new Event("cogpit-auth-required"))
      return Promise.reject(new Error("Authentication required"))
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
 * Wrapper around fetch that injects the auth token for remote clients and routes
 * string `/api/*` URLs to the active device. For local clients on the local
 * device this is a transparent passthrough (plus the `X-Cogpit-Client` header).
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
 * Append auth token to a URL for EventSource (which can't set headers). Routes
 * `/api/*` URLs to the active device first.
 */
export function authUrl(url: string): string {
  url = withBase(url)
  if (!isRemoteClient()) return url
  const token = getToken()
  if (!token) {
    window.dispatchEvent(new Event("cogpit-auth-required"))
    return url
  }
  const sep = url.includes("?") ? "&" : "?"
  return `${url}${sep}token=${encodeURIComponent(token)}`
}
