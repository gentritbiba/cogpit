import { DeviceUnreachableError } from "../hub/device-client"
import { DeviceRequestError, deviceJson } from "../hub/deviceRequest"
import { getDevice, type HubDevice } from "../hub/registry"
import type { PendingInput } from "../agents/pendingInput"
import type { SessionResult } from "../lib/sessionResult"
import type { SessionState, WaitResult } from "../lib/sessionWait"
import { startFields, type HostProject, type SessionAddress, type SessionHost } from "./types"

/**
 * Sessions on a device registered with the hub, driven through the same
 * endpoints the session CLI uses locally. Every call asks the device to answer
 * for itself only, so two Cogpits registered with each other never bounce an
 * unknown session between them.
 */

export const SESSION_SCOPE_HEADER = "x-cogpit-session-scope"
const LOCAL_SCOPE = { [SESSION_SCOPE_HEADER]: "local" }

/** Session control needs the device to run a Cogpit with these endpoints. */
const SESSION_API_VERSION = 1

/** How long a device may be silent before a wait gives up on it for this poll. */
const RETRY_DELAY_MS = 2000
const WAIT_GRACE_MS = 30_000
const CREATE_TIMEOUT_MS = 60_000
const CREATE_ATTEMPTS = 3

const sessionApiChecked = new Map<string, number>()

function connectionKey(device: HubDevice): number {
  return device.connectionRevision ?? 0
}

function unreachable(sessionId: string, error: unknown): SessionState {
  return {
    sessionId,
    outcome: "unreachable",
    live: false,
    running: false,
    waiting: [],
    error: error instanceof Error ? error.message : String(error),
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener("abort", done, { once: true })
  })
}

function registered(deviceId: string): HubDevice {
  const found = getDevice(deviceId)
  if (!found) throw new DeviceRequestError(deviceId, 404, `Device "${deviceId}" is no longer registered`, "UNKNOWN_DEVICE")
  return found
}

/** Refuse a device whose Cogpit predates the session endpoints, naming the fix. */
export async function ensureSessionApi(deviceId: string): Promise<void> {
  const current = registered(deviceId)
  if (sessionApiChecked.get(deviceId) === connectionKey(current)) return
  const hello = await deviceJson<{ version?: string; sessionApi?: number }>(deviceId, "GET", "/api/hello")
  if ((hello.sessionApi ?? 0) < SESSION_API_VERSION) {
    throw new DeviceRequestError(
      deviceId,
      426,
      `${current.name} runs Cogpit ${hello.version ?? "(unknown version)"}, which cannot run sessions for another machine. Update it first.`,
      "DEVICE_TOO_OLD",
    )
  }
  sessionApiChecked.set(deviceId, connectionKey(current))
}

export function createRemoteHost(deviceId: string): SessionHost {
  async function call<T>(method: string, path: string, body?: unknown, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    await ensureSessionApi(deviceId)
    return deviceJson<T>(deviceId, method, path, body, { ...options, headers: LOCAL_SCOPE })
  }

  const encoded = (sessionId: string) => encodeURIComponent(sessionId)

  return {
    id: deviceId,
    get name() {
      return getDevice(deviceId)?.name ?? deviceId
    },
    remote: true,

    /**
     * The device may still be starting a session when the answer is lost, so
     * a lost answer is asked again with the same request id, which the device
     * resolves to that one session instead of starting another.
     */
    async create(input) {
      const body = { ...startFields(input), requestId: input.requestId }
      for (let attempt = 1; ; attempt++) {
        try {
          const started = await call<{ sessionId: string; dirName: string }>(
            "POST", "/api/create-and-send", body, { timeoutMs: CREATE_TIMEOUT_MS },
          )
          return { sessionId: started.sessionId, dirName: started.dirName }
        } catch (error) {
          if (!(error instanceof DeviceUnreachableError) || attempt >= CREATE_ATTEMPTS) throw error
          await sleep(RETRY_DELAY_MS)
        }
      }
    },

    send(sessionId, message, { interrupt = false } = {}) {
      return call("POST", "/api/session-send", { sessionId, message, interrupt })
    },

    async state(sessionId) {
      try {
        return await call<SessionState>("GET", `/api/session-status/${encoded(sessionId)}`)
      } catch (error) {
        if (error instanceof DeviceRequestError && error.status === 404 && error.code !== "UNKNOWN_DEVICE") {
          return { sessionId, outcome: "not_found", live: false, running: false, waiting: [] }
        }
        if (error instanceof DeviceUnreachableError) return unreachable(sessionId, error)
        throw error
      }
    },

    /**
     * One long poll on the device, repeated while it cannot be reached so a
     * network blip does not end the wait early. A device that stays silent
     * until the deadline reports its sessions as unreachable.
     */
    async wait(sessionIds, { mode, timeoutMs, signal }) {
      const deadline = Date.now() + timeoutMs
      let lastError: unknown
      for (;;) {
        const remainingMs = Math.max(0, deadline - Date.now())
        try {
          return await call<WaitResult>("POST", "/api/session-wait", {
            sessionIds,
            mode,
            timeout: remainingMs / 1000,
          }, { signal, timeoutMs: remainingMs + WAIT_GRACE_MS })
        } catch (error) {
          if (!(error instanceof DeviceUnreachableError)) throw error
          lastError = error
        }
        if (signal?.aborted || Date.now() + RETRY_DELAY_MS >= deadline) {
          return { timedOut: true, sessions: sessionIds.map((id) => unreachable(id, lastError)) }
        }
        await sleep(RETRY_DELAY_MS, signal)
      }
    },

    async result(sessionId, turn) {
      try {
        const query = turn === undefined ? "" : `?turn=${turn}`
        return await call<SessionResult>("GET", `/api/session-result/${encoded(sessionId)}${query}`)
      } catch (error) {
        if (error instanceof DeviceRequestError && error.status === 404 && error.code !== "UNKNOWN_DEVICE") return null
        throw error
      }
    },

    async respond(sessionId, requestId, response) {
      const { answered } = await call<{ answered: PendingInput }>("POST", "/api/session-respond", {
        sessionId,
        requestId,
        ...response,
      })
      return answered
    },

    async interrupt(sessionId) {
      return (await call<{ success: boolean }>("POST", "/api/interrupt-session", { sessionId })).success
    },

    async stop(sessionId) {
      return (await call<{ success: boolean }>("POST", "/api/stop-session", { sessionId })).success
    },

    async has(sessionId) {
      const state = await this.state(sessionId)
      return state.outcome !== "not_found" && state.outcome !== "unreachable"
    },

    async address(sessionId) {
      try {
        return await call<SessionAddress>("GET", `/api/find-session/${encoded(sessionId)}`)
      } catch (error) {
        if (error instanceof DeviceRequestError && error.status === 404 && error.code !== "UNKNOWN_DEVICE") return null
        throw error
      }
    },

    projects() {
      return call<HostProject[]>("GET", "/api/projects")
    },
  }
}
