// ── Renderer capability gate (team edition) ─────────────────────────────
//
// A module cell mirroring the latest /api/me response so components can gate
// affordances inline at render time, exactly like isRemoteDeviceActive().
// Defaults to all-capabilities (personal parity) until useMe resolves — the
// server enforces every capability regardless; this only shapes the UI.

import { ALL_CAPABILITIES, type Capabilities, type MeResponse } from "../../shared/contracts/team"

let current: Capabilities = ALL_CAPABILITIES
const listeners = new Set<() => void>()

/** Called by useMe whenever /api/me resolves (or falls back to personal). */
export function setMe(me: MeResponse | null): void {
  current = me?.capabilities ?? ALL_CAPABILITIES
  for (const listener of listeners) listener()
}

/** Render-time capability check for inline gating. */
export function can(cap: keyof Capabilities): boolean {
  return current[cap]
}

/** Subscribe React consumers that must update even through memo boundaries. */
export function subscribeCapabilities(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function __resetCapabilitiesForTest(): void {
  current = ALL_CAPABILITIES
  for (const listener of listeners) listener()
}
