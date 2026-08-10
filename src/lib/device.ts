// ── Multi-device hub client helpers ─────────────────────────────────────
//
// The browser always stays on the hub origin. When a remote device is active,
// the URL carries a leading "/d/:deviceId" segment and API traffic is routed to
// the hub reverse-proxy under "/hub/:deviceId/*". Unprefixed "/api/*" always
// means "this machine" (the local/hub device) — see the external-agent contract
// in the cogpit-sessions skill.

export const LOCAL_DEVICE_ID = "local"

const LAST_PATH_PREFIX = "cogpit-last-path::"
const deviceConnectionRevisions = new Map<string, number>()

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

// ── Active identity (team edition) ───────────────────────────────────────

let activeUserId: string | null = null

/**
 * Record the signed-in team user (written by useMe). Personal edition and
 * logged-out states pass null, keeping every storage key byte-identical to
 * pre-team builds so existing localStorage survives. Actual transitions
 * dispatch `cogpit-identity-changed` so DeviceRoot can remount the App
 * subtree — mount-time storage reads must re-run through the new scope.
 */
export function setActiveIdentity(userId: string | null): void {
  if (userId === activeUserId) return
  activeUserId = userId
  window.dispatchEvent(new Event("cogpit-identity-changed"))
}

/** The signed-in team user id, or null in personal/logged-out states. */
export function getActiveIdentity(): string | null {
  return activeUserId
}

/** Latest server-backed connection revision observed for a registry device. */
export function getDeviceConnectionRevision(deviceId: string): number {
  return deviceId === LOCAL_DEVICE_ID ? 0 : (deviceConnectionRevisions.get(deviceId) ?? 0)
}

/**
 * Publish a registry revision before renderer state consumes the corresponding
 * device summary. Revisions are monotonic, so a slower list response cannot
 * roll the active scope backwards. Changes notify DeviceRoot, which filters
 * for the active id and remounts on a same-id host/account update.
 */
export function recordDeviceConnectionRevision(deviceId: string, revision: number): boolean {
  if (deviceId === LOCAL_DEVICE_ID || !Number.isSafeInteger(revision) || revision < 0) return false
  const current = deviceConnectionRevisions.get(deviceId)
  if (current !== undefined && revision <= current) return false
  deviceConnectionRevisions.set(deviceId, revision)
  window.dispatchEvent(new CustomEvent("cogpit-device-scope-changed", {
    detail: { deviceId, connectionRevision: revision },
  }))
  return true
}

/** Device id plus connection revision, used by async guards and module caches. */
export function getActiveDeviceScope(): string {
  const id = getActiveDeviceId()
  const revision = getDeviceConnectionRevision(id)
  return revision === 0 ? id : `${id}@${revision}`
}

export function __resetIdentityForTest(): void {
  activeUserId = null
}

export function __resetDeviceRevisionsForTest(): void {
  deviceConnectionRevisions.clear()
}

/**
 * Scope a cache/storage key to the active device so per-device state does not
 * collide. Local device keeps the bare key (warm switch-back for free). When a
 * team identity is active, keys are additionally scoped per user so two users
 * sharing a browser never read each other's state.
 */
export function deviceScopedKey(base: string): string {
  const id = getActiveDeviceId()
  const scope = getActiveDeviceScope()
  if (activeUserId !== null) return `${base}::${scope}::${activeUserId}`
  return id === LOCAL_DEVICE_ID ? base : `${base}::${scope}`
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
