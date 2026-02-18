// ── Network auth utilities ──────────────────────────────────────────────

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
 * Wrapper around fetch that injects the auth token for remote clients.
 * For local clients, this is a transparent passthrough.
 */
export function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!isRemoteClient()) return fetch(input, init)

  const token = getToken()
  if (!token) {
    window.dispatchEvent(new Event("cogpit-auth-required"))
    return Promise.reject(new Error("Authentication required"))
  }

  const headers = new Headers(init?.headers)
  headers.set("Authorization", `Bearer ${token}`)

  return fetch(input, { ...init, headers }).then((res) => {
    if (res.status === 401) {
      clearToken()
      window.dispatchEvent(new Event("cogpit-auth-required"))
      return Promise.reject(new Error("Authentication required"))
    }
    return res
  })
}

/**
 * Append auth token to a URL for EventSource (which can't set headers).
 */
export function authUrl(url: string): string {
  if (!isRemoteClient()) return url
  const token = getToken()
  if (!token) {
    window.dispatchEvent(new Event("cogpit-auth-required"))
    return url
  }
  const sep = url.includes("?") ? "&" : "?"
  return `${url}${sep}token=${encodeURIComponent(token)}`
}
