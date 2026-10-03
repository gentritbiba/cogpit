// Browser-safe identity contracts every edition shares (dependency rule 1: no runtime imports).

export const COGPIT_EDITIONS = ["personal", "team"] as const
export type CogpitEdition = (typeof COGPIT_EDITIONS)[number]

export function isCogpitEdition(value: unknown): value is CogpitEdition {
  return COGPIT_EDITIONS.includes(value as CogpitEdition)
}

/**
 * How a server's own sign-in works, from `/api/hello`: the network password,
 * which a local browser skips, or an account (username and password) that
 * every browser, local ones included, signs in with.
 */
export type SignInMode = "password" | "account"

/**
 * Response header on a request refused while the server keeps the caller out
 * of everything but what can let them back in. Its value is the server's own
 * reason, the same one `/api/me` reports as `gate`.
 */
export const GATE_HEADER = "X-Cogpit-Gate"

/** A signed-in account as every edition names it. An edition may attach more. */
export interface AccountPublic {
  id: string
  username: string
  displayName: string
}

/** What core's UI may offer the caller. The server enforces the same boundaries. */
export type Capabilities = {
  terminal: boolean
  configWrite: boolean
  /** Access to caller-selected host paths (project files, diffs, undo, scripts). */
  hostFiles: boolean
  manageDevices: boolean
  killAny: boolean
  /** Inspect provider account identity, quota, credit, and usage metadata. */
  viewUsage: boolean
  /**
   * Hand a session to a guest over a share link. A guest can approve tool
   * permission requests, so sharing grants a stranger host code execution.
   */
  share: boolean
  /**
   * The Browser panel. What it lists and lets the caller do is decided per
   * browser by the server, so an edition may grant it without `hostFiles`.
   */
  browser: boolean
}

/** Core's capabilities plus any an edition adds. */
export type CapabilitySet = Capabilities & Readonly<Record<string, boolean>>

export const ALL_CAPABILITIES: Capabilities = {
  terminal: true,
  configWrite: true,
  hostFiles: true,
  manageDevices: true,
  killAny: true,
  viewUsage: true,
  share: true,
  browser: true,
}

/** Fail-closed renderer state while an identity is unresolved. */
export const NO_CAPABILITIES: Capabilities = {
  terminal: false,
  configWrite: false,
  hostFiles: false,
  manageDevices: false,
  killAny: false,
  viewUsage: false,
  share: false,
  browser: false,
}

export interface MeResponse {
  authenticated: boolean
  edition: CogpitEdition
  user: AccountPublic | null
  capabilities: CapabilitySet
  /** The server decides per session what the caller may do; absent, every session is the caller's own. */
  enforcesSessionAccess?: true
  /**
   * Set while the server keeps the caller out of everything but what can let
   * them back in: the server's own reason, which the client shows as a gate.
   */
  gate?: string
}
