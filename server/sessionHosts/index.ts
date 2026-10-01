import { getDevice, listDevices } from "../hub/registry"
import { recordSessionOrigin, sessionOrigin, type SessionOrigin } from "../lib/sessionOrigins"
import type { SessionState, WaitOptions, WaitResult } from "../lib/sessionWait"
import { RouteError, ErrorCodes } from "../lib/routeError"
import { localHost } from "./localHost"
import { createRemoteHost } from "./remoteHost"
import type { SessionHost } from "./types"

export { localHost } from "./localHost"
export { ensureSessionApi, SESSION_SCOPE_HEADER } from "./remoteHost"
export type { HostCreateInput, HostProject, SessionHost } from "./types"

/** How long an unknown session may take to turn up on some device. */
const LOCATE_TIMEOUT_MS = 5000

const remoteHosts = new Map<string, SessionHost>()

function remoteHost(deviceId: string): SessionHost {
  let host = remoteHosts.get(deviceId)
  if (!host) {
    host = createRemoteHost(deviceId)
    remoteHosts.set(deviceId, host)
  }
  return host
}

/** A device named by its registry id, its name or its host; `local` is this machine. */
export function hostNamed(name: string): SessionHost {
  const wanted = name.trim().toLowerCase()
  if (wanted === "local" || wanted === "localhost") return localHost
  const devices = listDevices()
  const match = devices.find((device) => device.id.toLowerCase() === wanted)
    ?? devices.find((device) => device.name.toLowerCase() === wanted)
    ?? devices.find((device) => device.host.toLowerCase() === wanted)
  if (!match) {
    const known = devices.map((device) => device.name).join(", ")
    throw new RouteError(404, ErrorCodes.NOT_FOUND, known
      ? `No device named "${name}". Known devices: ${known}`
      : `No device named "${name}"; this Cogpit has no devices registered`)
  }
  return remoteHost(match.id)
}

export function remoteHostsList(): SessionHost[] {
  return listDevices().map((device) => remoteHost(device.id))
}

function firstTrue(checks: Promise<SessionHost | null>[]): Promise<SessionHost | null> {
  return new Promise((resolve) => {
    let pending = checks.length
    if (pending === 0) resolve(null)
    for (const check of checks) {
      void check.then((host) => {
        if (host) resolve(host)
        else if (--pending === 0) resolve(null)
      })
    }
  })
}

/** The host a recorded origin names, when its device is still registered. */
export function hostForOrigin(origin: SessionOrigin | null): SessionHost | null {
  if (!origin?.deviceId) return null
  return getDevice(origin.deviceId) ? remoteHost(origin.deviceId) : null
}

/**
 * The machine a session runs on: the device recorded when the hub started it,
 * this machine, or whichever device turns out to hold it — found once, then
 * remembered. An unknown session resolves to this machine, which reports it
 * as not found.
 */
export async function hostForSession(sessionId: string, options: { localOnly?: boolean } = {}): Promise<SessionHost> {
  if (options.localOnly) return localHost
  const recorded = hostForOrigin(await sessionOrigin(sessionId))
  if (recorded) return recorded
  if (await localHost.has(sessionId)) return localHost

  const timeout = new Promise<null>((resolve) => setTimeout(resolve, LOCATE_TIMEOUT_MS, null).unref?.())
  const found = await Promise.race([
    firstTrue(remoteHostsList().map((host) => host.has(sessionId).then((has) => (has ? host : null), () => null))),
    timeout,
  ])
  if (!found) return localHost
  await recordSessionOrigin(sessionId, { deviceId: found.id }).catch(() => {})
  return found
}

export interface HostedSession {
  host: SessionHost
  sessionId: string
}

export async function locateSessions(sessionIds: readonly string[], options: { localOnly?: boolean } = {}): Promise<HostedSession[]> {
  return Promise.all(sessionIds.map(async (sessionId) => ({ host: await hostForSession(sessionId, options), sessionId })))
}

/** A session's state, or its failure to answer as an error state, so one machine cannot sink a wait on several. */
async function stateOrError(host: SessionHost, sessionId: string): Promise<SessionState> {
  try {
    return await host.state(sessionId)
  } catch (error) {
    return {
      sessionId,
      outcome: "error",
      live: false,
      running: false,
      waiting: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Wait on sessions spread over several machines: one long poll per machine,
 * all at once. In `any` mode the first machine to report a settled session
 * cancels the rest, whose sessions are then read as they stand.
 */
export async function waitAcrossHosts(
  sessions: readonly HostedSession[],
  { mode, timeoutMs, signal }: WaitOptions,
): Promise<WaitResult> {
  const groups = new Map<SessionHost, string[]>()
  for (const { host, sessionId } of sessions) groups.set(host, [...(groups.get(host) ?? []), sessionId])
  if (groups.size === 1) {
    const [[host, ids]] = groups
    return host.wait(ids, { mode, timeoutMs, signal })
  }

  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener("abort", abort, { once: true })
  try {
    const results = await Promise.all([...groups].map(async ([host, ids]) => {
      try {
        const result = await host.wait(ids, { mode, timeoutMs, signal: controller.signal })
        if (mode === "any" && !result.timedOut) controller.abort()
        return { host, ids, result }
      } catch {
        return { host, ids, result: null }
      }
    }))
    const states = new Map<string, SessionState>()
    await Promise.all(results.map(async ({ host, ids, result }) => {
      const found = result?.sessions ?? await Promise.all(ids.map((id) => stateOrError(host, id)))
      for (const state of found) states.set(state.sessionId, state)
    }))
    const timedOut = mode === "all"
      ? results.some(({ result }) => !result || result.timedOut)
      : !results.some(({ result }) => result && !result.timedOut)
    return { timedOut, sessions: sessions.map(({ sessionId }) => states.get(sessionId)!) }
  } finally {
    signal?.removeEventListener("abort", abort)
  }
}
