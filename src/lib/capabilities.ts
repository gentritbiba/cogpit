// ── Renderer identity + capability gate ─────────────────────────────────
//
// A module cell mirroring the latest /api/me response so components can gate
// affordances inline at render time, exactly like isRemoteDeviceActive().
// Defaults to all-capabilities (personal parity) until useMe first runs — the
// server enforces every capability regardless; this only shapes the UI.
//
// The identity belongs to the device it was read from: after a device switch
// it reads as unresolved until useMe has asked the new device. Unresolved has
// no edition, so nothing reads it as personal and grants a personal default.

import { getActiveDeviceScope } from "@/lib/device"
import {
  ALL_CAPABILITIES,
  NO_CAPABILITIES,
  type AccountPublic,
  type Capabilities,
  type CapabilitySet,
  type CogpitEdition,
  type MeResponse,
} from "../../shared/contracts/identity"

export interface CurrentUser {
  /** Null while the active device's identity is unresolved. */
  edition: CogpitEdition | null
  /** The signed-in account; null on a server without accounts and while unresolved. */
  user: AccountPublic | null
  /** The account signed in to this browser's own server (the hub); null on a hub without accounts. */
  hubUser: AccountPublic | null
  /** Whether the server decides per session what the caller may do; null while unresolved. */
  enforcesSessionAccess: boolean | null
}

interface Identity {
  capabilities: CapabilitySet
  user: CurrentUser
  /** Why the server keeps the caller out, when the app then shows only the gate. */
  gate: string | null
}

const PERSONAL: Identity = {
  capabilities: ALL_CAPABILITIES,
  user: { edition: "personal", user: null, hubUser: null, enforcesSessionAccess: false },
  gate: null,
}
const UNRESOLVED: Identity = {
  capabilities: NO_CAPABILITIES,
  user: { edition: null, user: null, hubUser: null, enforcesSessionAccess: null },
  gate: null,
}

let identity: Identity = PERSONAL
/** The device scope `identity` was read from; null until useMe first settles. */
let identityScope: string | null = null
const listeners = new Set<() => void>()

/**
 * Called by useMe with the active device's identity, or null while it is
 * unresolved. `hubUser` differs from `me.user` only on a remote device.
 */
export function setMe(me: MeResponse | null, hubUser: AccountPublic | null = me?.user ?? null): void {
  identity = me
    ? {
        capabilities: me.capabilities,
        user: {
          edition: me.edition,
          user: me.user,
          hubUser,
          enforcesSessionAccess: me.enforcesSessionAccess === true,
        },
        gate: me.gate ?? null,
      }
    : UNRESOLVED
  identityScope = getActiveDeviceScope()
  for (const listener of listeners) listener()
}

function activeIdentity(): Identity {
  return identityScope === null || identityScope === getActiveDeviceScope() ? identity : UNRESOLVED
}

/** Render-time capability check for inline gating. A capability the server does not report is not held. */
export function can(cap: keyof Capabilities | (string & {})): boolean {
  const { capabilities } = activeIdentity()
  return Object.hasOwn(capabilities, cap) && capabilities[cap] === true
}

/** The edition and user of the active device, as that device knows the caller. */
export function getCurrentUser(): CurrentUser {
  return activeIdentity().user
}

/** Why the active device keeps the caller out, or null. */
export function getAppGate(): string | null {
  return activeIdentity().gate
}

/** Subscribe React consumers that must update even through memo boundaries. */
export function subscribeCapabilities(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function __resetCapabilitiesForTest(): void {
  identity = PERSONAL
  identityScope = null
  for (const listener of listeners) listener()
}
