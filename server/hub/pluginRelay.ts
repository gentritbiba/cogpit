import { randomBytes } from "node:crypto"
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http"
import { request as httpsRequest } from "node:https"
import { getDevice, sameDeviceConnection, type HubDevice } from "./registry"
import { DeviceAuthError, getDeviceTokenLease, invalidateDeviceTokenGeneration, mintFailureCode, type DeviceTokenLease } from "./device-client"
import { onDeviceConnectionsInvalidated } from "./connection-invalidation"
import { onSessionRevoked } from "../security"
import type { RequestAuthentication } from "../requestAuthentication"
import {
  isPluginAuthenticationActive, PluginAuthorizationError, PLUGIN_SESSION_HEADER, PLUGIN_SESSION_TTL_MS,
  pluginSessionHeader, requirePluginAuthentication, samePluginAuthentication, staleActivation,
} from "../plugins/authorization"
import { parseJsonText } from "../plugins/json"

const MAX_RELAY_RESPONSE_BYTES = 4 * 1024 * 1024 + 16 * 1024
const MAX_RELAY_SESSIONS = 512
const REQUEST_TIMEOUT_MS = 30_000

export interface PluginRelayRequest {
  device: HubDevice
  token: DeviceTokenLease
  method: string
  path: string
  sessionId?: string
  contentType?: string
  stageHeaders?: { client?: string; scope?: string }
  body: Buffer
  signal: AbortSignal
}
export interface PluginRelayResponse { status: number; contentType: string; body: Buffer }
export type PluginRelayTransport = (request: PluginRelayRequest) => Promise<PluginRelayResponse>

interface RelaySession {
  id: string
  downstreamId: string
  authentication: RequestAuthentication
  device: HubDevice
  token: DeviceTokenLease
  expiresAt: number
  abort: AbortController
}
interface PendingRequest {
  authentication: RequestAuthentication
  deviceId: string
  abort: AbortController
}

export function isPluginRelayPath(path: string): boolean {
  return /^\/api\/plugins(?:\/|$)/i.test(path)
}

export function isPluginRelayHeader(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.startsWith("x-cogpit-plugin-") || lower.startsWith("x-cogpit-relay-")
}

export const sendPluginRelayRequest: PluginRelayTransport = (input) => new Promise((resolve, reject) => {
  const request = (input.device.tls ? httpsRequest : httpRequest)({
    hostname: input.device.host, port: input.device.port, method: input.method, path: input.path,
    signal: input.signal,
    headers: {
      "X-Cogpit-Client": "1", "Content-Length": String(input.body.length),
      ...(input.contentType ? { "Content-Type": input.contentType } : {}),
      ...(input.stageHeaders?.client ? { "X-Cogpit-Plugin-Client": input.stageHeaders.client } : {}),
      ...(input.stageHeaders?.scope ? { "X-Cogpit-Plugin-Scope": input.stageHeaders.scope } : {}),
      ...(input.sessionId ? { [PLUGIN_SESSION_HEADER]: input.sessionId } : {}),
      ...(input.device.auth === "password" && input.token.token ? { Authorization: `Bearer ${input.token.token}` } : {}),
    },
  })
  const timeout = setTimeout(() => request.destroy(new Error("Plugin relay timed out")), REQUEST_TIMEOUT_MS)
  timeout.unref?.()
  request.once("close", () => clearTimeout(timeout))
  request.once("error", reject)
  request.once("response", (response) => {
    const chunks: Buffer[] = []
    let length = 0
    response.on("data", (chunk: Buffer) => {
      length += chunk.length
      if (length > MAX_RELAY_RESPONSE_BYTES) {
        response.destroy(new Error("Plugin relay response exceeds its limit"))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    response.once("error", reject)
    response.once("aborted", () => reject(new Error("Plugin relay response aborted")))
    response.once("end", () => resolve({
      status: response.statusCode ?? 502,
      contentType: response.headers["content-type"] ?? "application/octet-stream",
      body: Buffer.concat(chunks),
    }))
  })
  request.end(input.body)
})

export class HubPluginRelay {
  private readonly sessions = new Map<string, RelaySession>()
  private readonly pending = new Set<PendingRequest>()
  private readonly revocations = new Set<Promise<void>>()
  private readonly unsubscribeSession: () => void
  private readonly unsubscribeDevice: () => void
  private readonly timer: ReturnType<typeof setInterval>
  private disposed = false
  private readonly now: () => number
  private readonly transport: PluginRelayTransport
  private readonly getToken: (device: HubDevice) => Promise<DeviceTokenLease>
  private readonly lookup: (id: string) => HubDevice | undefined

  constructor(options: {
    now?: () => number; transport?: PluginRelayTransport;
    getToken?: (device: HubDevice) => Promise<DeviceTokenLease>;
    getDevice?: (id: string) => HubDevice | undefined;
  } = {}) {
    this.now = options.now ?? Date.now
    this.transport = options.transport ?? sendPluginRelayRequest
    this.getToken = options.getToken ?? getDeviceTokenLease
    this.lookup = options.getDevice ?? getDevice
    this.unsubscribeSession = onSessionRevoked((token) => {
      const matches = (authentication: RequestAuthentication) => token === null
        || authentication.kind === "session" && authentication.token === token
      for (const [id, session] of this.sessions) if (matches(session.authentication)) this.remove(id)
      for (const request of this.pending) if (matches(request.authentication)) request.abort.abort()
    })
    this.unsubscribeDevice = onDeviceConnectionsInvalidated((deviceId) => {
      for (const [id, session] of this.sessions) if (session.device.id === deviceId) this.remove(id)
      for (const request of this.pending) if (request.deviceId === deviceId) request.abort.abort()
    })
    this.timer = setInterval(() => this.sweep(), 1000)
    this.timer.unref?.()
  }

  async forward(req: IncomingMessage, res: ServerResponse, deviceId: string, method: string, path: string, body: Buffer): Promise<void> {
    try {
      const response = await this.request(req, deviceId, method, path, body, res)
      if (res.destroyed || res.writableEnded) return
      res.statusCode = response.status
      res.setHeader("Content-Type", response.contentType)
      res.setHeader("Cache-Control", "no-store")
      res.setHeader("X-Cogpit-Device", deviceId)
      res.end(response.body)
    } catch (error) {
      if (res.destroyed || res.writableEnded) return
      const authError = error instanceof PluginAuthorizationError
      const code = authError ? error.code : mintFailureCode(error)
      res.statusCode = authError ? error.status : 502
      res.setHeader("Content-Type", "application/json")
      res.setHeader("Cache-Control", "no-store")
      res.setHeader("X-Cogpit-Device", deviceId)
      if (!authError) res.setHeader("X-Cogpit-Hub-Error", code)
      res.end(JSON.stringify({ code, error: authError ? error.message : "The selected host could not complete the plugin request" }))
    }
  }

  async request(req: IncomingMessage, deviceId: string, method: string, path: string, body: Buffer, response?: ServerResponse): Promise<PluginRelayResponse> {
    if (this.disposed) return staleActivation()
    const authentication = requirePluginAuthentication(req)
    const pathname = path.split("?")[0]!
    if (!/^\/api\/plugins(?:\/[a-zA-Z0-9_.-]+)*$/.test(pathname) || pathname.split("/").some((part) => part === "." || part === "..")) {
      throw new PluginAuthorizationError(403, "PERMISSION_REQUIRED", "Invalid plugin relay route")
    }
    if (pathname === "/api/plugins/events") throw new PluginAuthorizationError(403, "PERMISSION_REQUIRED", "Plugin relay streams are unavailable")
    if (body.length > 4 * 1024 * 1024) throw new PluginAuthorizationError(429, "RATE_LIMITED", "Plugin upload exceeds its size limit")
    const minting = method === "POST" && pathname === "/api/plugins/session"
    const deleting = method === "DELETE" && pathname === "/api/plugins/session"
    const stageHeaders = method === "POST" && pathname === "/api/plugins/stage" ? {
      client: this.stageHeader(req, "x-cogpit-plugin-client"),
      scope: this.stageHeader(req, "x-cogpit-plugin-scope"),
    } : undefined
    const incomingId = pluginSessionHeader(req)
    const session = incomingId ? this.resolve(incomingId, authentication, deviceId) : undefined
    if (!minting && !session) return staleActivation()
    this.sweep()
    if (!session && this.sessions.size + this.pending.size >= MAX_RELAY_SESSIONS) throw new PluginAuthorizationError(429, "RATE_LIMITED", "Too many plugin relay sessions")
    const device = this.lookup(deviceId)
    if (!device) return staleActivation()
    const snapshot = { ...device }
    const abort = new AbortController()
    const pending = { authentication, deviceId, abort }
    this.pending.add(pending)
    const cancel = () => abort.abort()
    const disconnect = () => { if (!response?.writableFinished) abort.abort() }
    session?.abort.signal.addEventListener("abort", cancel, { once: true })
    response?.once("close", disconnect)
    let mintedId: string | null = null
    let token: DeviceTokenLease | null = null
    try {
      token = session?.token ?? await this.getToken(snapshot)
      this.assertCurrent(authentication, snapshot, abort.signal)
      const makeRequest = () => this.transport({
        device: snapshot, token: token!, method, path, body, signal: abort.signal,
        sessionId: session?.downstreamId,
        contentType: typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : undefined,
        stageHeaders,
      })
      let result = await makeRequest()
      if (result.status === 401 && !session && snapshot.auth === "password") {
        invalidateDeviceTokenGeneration(deviceId, token.generation)
        token = await this.getToken(snapshot)
        this.assertCurrent(authentication, snapshot, abort.signal)
        result = await makeRequest()
      }
      if (minting && result.status >= 200 && result.status < 300) {
        const value = parseJsonText(result.body, 4096)
        if (!value || typeof value !== "object" || Array.isArray(value)) return staleActivation()
        const data = value as Record<string, unknown>
        if (Object.keys(data).some((key) => key !== "sessionId" && key !== "expiresAt")
          || typeof data.sessionId !== "string" || !/^[a-f0-9]{64}$/.test(data.sessionId)
          || typeof data.expiresAt !== "number" || !Number.isSafeInteger(data.expiresAt) || data.expiresAt <= this.now()) return staleActivation()
        mintedId = data.sessionId
        if (session && data.sessionId !== session.downstreamId) return staleActivation()
        this.assertCurrent(authentication, snapshot, abort.signal)
        const expiresAt = Math.min(data.expiresAt, this.now() + PLUGIN_SESSION_TTL_MS)
        const mapped = session ?? {
          id: randomBytes(32).toString("hex"), downstreamId: data.sessionId,
          authentication, device: snapshot, token, expiresAt, abort: new AbortController(),
        }
        mapped.expiresAt = expiresAt
        this.sessions.set(mapped.id, mapped)
        mintedId = null
        return { status: result.status, contentType: "application/json", body: Buffer.from(JSON.stringify({ sessionId: mapped.id, expiresAt })) }
      }
      this.assertCurrent(authentication, snapshot, abort.signal)
      if (result.status === 401) {
        if (session) this.remove(session.id)
        throw new DeviceAuthError(deviceId, "Selected host rejected the plugin credential")
      }
      if (deleting && result.status >= 200 && result.status < 300 && session) this.remove(session.id, false)
      return result
    } finally {
      this.pending.delete(pending)
      response?.removeListener("close", disconnect)
      session?.abort.signal.removeEventListener("abort", cancel)
      if (mintedId && token) this.queueRevocation(snapshot, token, mintedId)
    }
  }

  private resolve(id: string, authentication: RequestAuthentication, deviceId: string): RelaySession {
    const session = this.sessions.get(id)
    if (!session || session.device.id !== deviceId || !samePluginAuthentication(session.authentication, authentication)) return staleActivation()
    if (session.expiresAt <= this.now() || !isPluginAuthenticationActive(session.authentication)) {
      this.remove(id)
      return staleActivation()
    }
    const device = this.lookup(deviceId)
    if (!device || !sameDeviceConnection(session.device, device)) {
      this.remove(id)
      return staleActivation()
    }
    return session
  }

  private stageHeader(req: IncomingMessage, name: string): string | undefined {
    const raw = req.headers[name]
    if (raw === undefined) return undefined
    try {
      if (typeof raw !== "string" || /[\r\n\0]/.test(raw)) throw new Error("Invalid header")
      parseJsonText(Buffer.from(raw), 16_384)
      return raw
    } catch {
      throw new PluginAuthorizationError(400, "INVALID_REQUEST", "Invalid plugin stage metadata header")
    }
  }

  private assertCurrent(authentication: RequestAuthentication, device: HubDevice, signal: AbortSignal): void {
    const current = this.lookup(device.id)
    if (this.disposed || signal.aborted || !isPluginAuthenticationActive(authentication) || !current || !sameDeviceConnection(device, current)) return staleActivation()
  }

  private queueRevocation(device: HubDevice, token: DeviceTokenLease, downstreamId: string): void {
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), 5000)
    timeout.unref?.()
    const pending = Promise.resolve().then(() => this.transport({
      device, token, method: "DELETE", path: "/api/plugins/session", sessionId: downstreamId,
      body: Buffer.alloc(0), signal: abort.signal,
    })).then(() => {}, () => {}).finally(() => {
      clearTimeout(timeout)
      this.revocations.delete(pending)
    })
    this.revocations.add(pending)
  }

  private remove(id: string, revokeDownstream = true): void {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    session.abort.abort()
    if (revokeDownstream) this.queueRevocation(session.device, session.token, session.downstreamId)
  }

  private sweep(): void {
    for (const [id, session] of this.sessions) {
      try { this.resolve(id, session.authentication, session.device.id) } catch { this.remove(id) }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    clearInterval(this.timer)
    this.unsubscribeSession()
    this.unsubscribeDevice()
    for (const request of this.pending) request.abort.abort()
    for (const id of [...this.sessions.keys()]) this.remove(id)
    await Promise.all([...this.revocations])
  }
}

let relay: HubPluginRelay | undefined
export function getHubPluginRelay(): HubPluginRelay {
  return relay ??= new HubPluginRelay()
}
export async function disposeHubPluginRelay(): Promise<void> {
  const current = relay
  relay = undefined
  await current?.dispose()
}
