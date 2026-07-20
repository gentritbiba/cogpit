// ── Multi-device hub client helpers ─────────────────────────────────────
//
// The browser always stays on the hub origin. When a remote device is active,
// the URL carries a leading "/d/:deviceId" segment and API traffic is routed to
// the hub reverse-proxy under "/hub/:deviceId/*". Unprefixed "/api/*" always
// means "this machine" (the local/hub device) — see the external-agent contract
// in the cogpit-sessions skill.

export const LOCAL_DEVICE_ID = "local"

const LAST_PATH_PREFIX = "cogpit-last-path::"

/**
 * The active device id, parsed from the leading "/d/:id" segment of the URL
 * path. Anything else (including claude dirNames that start with "-" and codex
 * dirNames that start with "codex__") resolves to the local device.
 */
export function getActiveDeviceId(): string {
  const path = typeof window !== "undefined" ? window.location?.pathname : undefined
  if (!path) return LOCAL_DEVICE_ID
  const match = /^\/d\/([^/]+)/.exec(path)
  return match ? match[1] : LOCAL_DEVICE_ID
}

export function isRemoteDeviceActive(): boolean {
  return getActiveDeviceId() !== LOCAL_DEVICE_ID
}

/**
 * The server-side proxy prefix for the active device: "" for the local device,
 * "/hub/<id>" for a remote device.
 */
export function devicePrefix(): string {
  const id = getActiveDeviceId()
  return id === LOCAL_DEVICE_ID ? "" : `/hub/${id}`
}

/**
 * Prefix a same-origin URL with the active device's proxy prefix. Only "/api/*"
 * and "/__pty" URLs are routed to a remote device. Hub-scoped URLs
 * ("/api/hub/*" device management, "/api/auth/*" hub authentication) are never
 * prefixed — they always target the hub itself.
 */
export function withBase(url: string): string {
  const prefix = devicePrefix()
  if (!prefix) return url
  if (url.startsWith("/api/hub/") || url.startsWith("/api/auth/")) return url
  if (url.startsWith("/api") || url.startsWith("/__pty")) return `${prefix}${url}`
  return url
}

/**
 * Scope a cache/storage key to the active device so per-device state does not
 * collide. Local device keeps the bare key (warm switch-back for free).
 */
export function deviceScopedKey(base: string): string {
  const id = getActiveDeviceId()
  return id === LOCAL_DEVICE_ID ? base : `${base}::${id}`
}

/**
 * Persist the last visited path for a device so switching back restores context.
 * Written by useUrlSync on every path change.
 */
export function saveLastPath(deviceId: string, path: string): void {
  sessionStorage.setItem(`${LAST_PATH_PREFIX}${deviceId}`, path)
}

/**
 * Switch the active device: navigate to the device's remembered last path (or a
 * fresh root for that device) and notify listeners so the app can remount.
 */
export function switchDevice(id: string): void {
  const saved = sessionStorage.getItem(`${LAST_PATH_PREFIX}${id}`)
  const target = saved ?? (id === LOCAL_DEVICE_ID ? "/" : `/d/${id}/`)
  window.history.pushState(null, "", target)
  window.dispatchEvent(new Event("cogpit-device-changed"))
}
