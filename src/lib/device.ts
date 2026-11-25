// ── Multi-device hub client helpers ─────────────────────────────────────
//
// The browser always stays on the hub origin. When a remote device is active,
// the URL carries a leading "/d/:deviceId" segment and API traffic is routed to
// the hub reverse-proxy under "/hub/:deviceId/*". Unprefixed "/api/*" always
// means "this machine" (the local/hub device) — see the external-agent contract
// in the `cogpit` skill's sessions guide.

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

/** The app path prefix for the active device: "" for the local device, "/d/<id>" for a remote one. */
export function devicePathPrefix(): string {
  const id = getActiveDeviceId()
  return id === LOCAL_DEVICE_ID ? "" : `/d/${id}`
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
 * and the socket transports ("/__pty", "/__browser") are routed to a remote
 * device. Hub-scoped URLs ("/api/hub/*" device management, "/api/auth/*" hub
 * authentication) are never prefixed — they always target the hub itself.
 */
export function withBase(url: string): string {
  const prefix = devicePrefix()
  if (!prefix) return url
  if (url.startsWith("/api/hub/") || url.startsWith("/api/auth/")) return url
  if (url.startsWith("/api") || url.startsWith("/__pty") || url.startsWith("/__browser")) {
    return `${prefix}${url}`
  }
  return url
}

// ── Active identity (account sign-in) ────────────────────────────────────

let activeUserId: string | null = null

/**
 * Record the hub's signed-in account (written by useMe). It scopes storage;
 * what the UI shows about the caller follows the active device (see
 * capabilities.ts). Personal edition and logged-out states pass null, keeping
 * every storage key byte-identical to builds without account sign-in so
 * existing localStorage survives. Actual transitions dispatch `cogpit-identity-changed` so DeviceRoot
 * can remount the App subtree — mount-time storage reads must re-run through
 * the new scope.
 */
export function setActiveIdentity(userId: string | null): void {
  if (userId === activeUserId) return
  activeUserId = userId
  window.dispatchEvent(new Event("cogpit-identity-changed"))
}

/** The hub's signed-in account id, or null in personal/logged-out states. */
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

/** A device id plus its connection revision, used by async guards and module caches. */
export function deviceScope(deviceId: string): string {
  const revision = getDeviceConnectionRevision(deviceId)
  return revision === 0 ? deviceId : `${deviceId}@${revision}`
}

/** The active device's {@link deviceScope}. */
export function getActiveDeviceScope(): string {
  return deviceScope(getActiveDeviceId())
}

export function __resetIdentityForTest(): void {
  activeUserId = null
}

export function __resetDeviceRevisionsForTest(): void {
  deviceConnectionRevisions.clear()
}

/**
 * Scope a cache/storage key to a device (the active one unless named) so
 * per-device state does not collide. Local device keeps the bare key. When a
 * signed-in account is active, keys are additionally scoped per account so two
 * people sharing a browser never read each other's state. While rendering, use
 * useDeviceScopedKey: a background pane renders for its own device.
 */
export function deviceScopedKey(base: string, deviceId = getActiveDeviceId()): string {
  const scope = deviceScope(deviceId)
  if (activeUserId !== null) return `${base}::${scope}::${activeUserId}`
  return deviceId === LOCAL_DEVICE_ID ? base : `${base}::${scope}`
}

/**
 * Persist the last visited path for a device so switching back restores context.
 * Written by useUrlSync on every path change.
 */
export function saveLastPath(deviceId: string, path: string): void {
  sessionStorage.setItem(`${LAST_PATH_PREFIX}${deviceId}`, path)
}

let switchTransition: ((id: string) => void) | null = null

/**
 * Let DeviceRoot carry explicit switches with a transition. The handler calls
 * {@link commitDeviceSwitch} once the target's slide is under way.
 */
export function setDeviceSwitchTransition(handler: ((id: string) => void) | null): void {
  switchTransition = handler
}

/** Switch the active device, through DeviceRoot's transition when one is installed. */
export function switchDevice(id: string): void {
  if (switchTransition) switchTransition(id)
  else commitDeviceSwitch(id)
}

/**
 * Make `id` the active device now: navigate to its remembered last path (or a
 * fresh root for it) and notify listeners.
 */
export function commitDeviceSwitch(id: string): void {
  const saved = sessionStorage.getItem(`${LAST_PATH_PREFIX}${id}`)
  const target = saved ?? (id === LOCAL_DEVICE_ID ? "/" : `/d/${id}/`)
  window.history.pushState(null, "", target)
  window.dispatchEvent(new Event("cogpit-device-changed"))
}
