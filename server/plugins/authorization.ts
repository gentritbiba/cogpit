import { randomBytes } from "node:crypto"
import type { IncomingMessage } from "node:http"
import { parseClientRuntimeDescriptor, type ClientRuntimeDescriptor } from "@cogpit/plugin-contracts"
import { getRequestAuthentication, type RequestAuthentication } from "../requestAuthentication"
import { getSessionPrincipal, isSessionTokenActive, onSessionRevoked } from "../security"
import { isTeamEdition } from "../team/edition"

export const PLUGIN_SESSION_HEADER = "x-cogpit-plugin-session"
export const PLUGIN_SESSION_TTL_MS = 60_000
const MAX_CLIENT_SESSIONS = 512

export class PluginAuthorizationError extends Error {
  constructor(readonly status: number, readonly code: "INVALID_REQUEST" | "PERMISSION_REQUIRED" | "STALE_ACTIVATION" | "RATE_LIMITED", message: string) {
    super(message)
  }
}

export function staleActivation(): never {
  throw new PluginAuthorizationError(409, "STALE_ACTIVATION", "Plugin session or activation is no longer valid")
}

export function pluginSessionHeader(req: IncomingMessage): string | null {
  const value = req.headers[PLUGIN_SESSION_HEADER]
  if (value === undefined) return null
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) return staleActivation()
  return value
}

export function isPluginAuthenticationActive(authentication: RequestAuthentication): boolean {
  if (authentication.kind === "local") return !isTeamEdition()
  if (!isSessionTokenActive(authentication.token)) return false
  const principal = getSessionPrincipal(authentication.token)
  if (authentication.principal) {
    return principal?.userId === authentication.principal.userId && principal.role === "admin"
  }
  return !isTeamEdition() && principal === null
}

export function requirePluginAuthentication(req: IncomingMessage): RequestAuthentication {
  const authentication = getRequestAuthentication(req)
  if (!authentication || !isPluginAuthenticationActive(authentication)) {
    throw new PluginAuthorizationError(403, "PERMISSION_REQUIRED", "Plugin administration requires an authenticated owner or administrator")
  }
  return authentication
}

export function samePluginAuthentication(left: RequestAuthentication, right: RequestAuthentication): boolean {
  return left.kind === "local" ? right.kind === "local"
    : right.kind === "session" && left.token === right.token && left.principal?.userId === right.principal?.userId
}

export interface PluginClientSession { sessionId: string; expiresAt: number }
export interface PluginAuthorizationBinding extends PluginClientSession {
  principalId: string
  hostInstanceId: string
}
interface ClientSession {
  binding: PluginAuthorizationBinding
  authentication: RequestAuthentication
  descriptor?: ClientRuntimeDescriptor
}

export class PluginAuthorization {
  private readonly sessions = new Map<string, ClientSession>()
  private readonly listeners = new Set<(sessionId: string) => void>()
  private readonly unsubscribe: () => void
  private readonly timer: ReturnType<typeof setInterval>
  private readonly now: () => number
  private readonly ttlMs: number
  private disposed = false

  constructor(private readonly options: { hostInstanceId: string; now?: () => number; ttlMs?: number }) {
    this.now = options.now ?? Date.now
    this.ttlMs = Math.min(options.ttlMs ?? PLUGIN_SESSION_TTL_MS, PLUGIN_SESSION_TTL_MS)
    if (!options.hostInstanceId || !Number.isFinite(this.ttlMs) || this.ttlMs <= 0) throw new Error("Invalid plugin authorization options")
    this.unsubscribe = onSessionRevoked((token) => {
      for (const [id, session] of this.sessions) {
        if (token === null || session.authentication.kind === "session" && session.authentication.token === token) this.revoke(id)
      }
    })
    this.timer = setInterval(() => this.sweep(), 1000)
    this.timer.unref?.()
  }

  createOrRenewSession(req: IncomingMessage, descriptor?: ClientRuntimeDescriptor): PluginClientSession {
    if (this.disposed) return staleActivation()
    const authentication = requirePluginAuthentication(req)
    let captured: ClientRuntimeDescriptor | undefined
    if (descriptor !== undefined) {
      try { captured = parseClientRuntimeDescriptor(descriptor) }
      catch { throw new PluginAuthorizationError(400, "INVALID_REQUEST", "Invalid plugin client descriptor") }
    }
    const existing = pluginSessionHeader(req)
    if (existing) {
      const binding = this.resolve(req)
      if (captured) this.sessions.get(existing)!.descriptor = captured
      binding.expiresAt = this.now() + this.ttlMs
      return { sessionId: binding.sessionId, expiresAt: binding.expiresAt }
    }
    this.sweep()
    if (this.sessions.size >= MAX_CLIENT_SESSIONS) throw new PluginAuthorizationError(429, "RATE_LIMITED", "Too many plugin client sessions")
    const binding: PluginAuthorizationBinding = {
      sessionId: randomBytes(32).toString("hex"),
      principalId: authentication.kind === "session" && authentication.principal ? authentication.principal.userId : "owner",
      hostInstanceId: this.options.hostInstanceId,
      expiresAt: this.now() + this.ttlMs,
    }
    this.sessions.set(binding.sessionId, { binding, authentication, ...(captured ? { descriptor: captured } : {}) })
    return { sessionId: binding.sessionId, expiresAt: binding.expiresAt }
  }

  activeClients(excludeSessionId?: string): ClientRuntimeDescriptor[] {
    this.sweep()
    return [...this.sessions.entries()].flatMap(([id, session]) => id !== excludeSessionId && session.descriptor ? [structuredClone(session.descriptor)] : [])
  }

  resolve(req: IncomingMessage): PluginAuthorizationBinding {
    const authentication = requirePluginAuthentication(req)
    const id = pluginSessionHeader(req)
    if (!id) return staleActivation()
    const session = this.sessions.get(id)
    if (!session || !samePluginAuthentication(session.authentication, authentication)) return staleActivation()
    return this.assertBinding(session.binding)
  }

  assertBinding(binding: PluginAuthorizationBinding): PluginAuthorizationBinding {
    const session = this.sessions.get(binding.sessionId)
    if (this.disposed || !session || session.binding !== binding) return staleActivation()
    if (binding.expiresAt <= this.now() || !isPluginAuthenticationActive(session.authentication)) {
      this.revoke(binding.sessionId)
      return staleActivation()
    }
    return binding
  }

  revokeSession(req: IncomingMessage): void {
    const binding = this.resolve(req)
    this.revoke(binding.sessionId)
  }

  onRevoked(listener: (sessionId: string) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private revoke(id: string): void {
    if (!this.sessions.delete(id)) return
    for (const listener of [...this.listeners]) {
      try { listener(id) } catch { /* A failed consumer must not preserve other leases. */ }
    }
  }

  private sweep(): void {
    for (const [id, session] of this.sessions) {
      if (session.binding.expiresAt <= this.now() || !isPluginAuthenticationActive(session.authentication)) this.revoke(id)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    clearInterval(this.timer)
    this.unsubscribe()
    for (const id of [...this.sessions.keys()]) this.revoke(id)
    this.listeners.clear()
  }
}
