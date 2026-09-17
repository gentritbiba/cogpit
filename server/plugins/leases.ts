import { randomBytes } from "node:crypto"
import { PluginAuthorization, PluginAuthorizationError, staleActivation, type PluginAuthorizationBinding } from "./authorization"

export const PLUGIN_LEASE_TTL_MS = 30_000
const MAX_LEASES = 1024

export interface PluginLeaseScope {
  pluginId: string
  digest: string
  workspacePath?: string | null
  projectKey: string | null
  contextEpoch: string
  grantsRevision: number
  connectionRevision: number
}

export interface PluginLease extends Readonly<PluginLeaseScope> {
  readonly id: string
  readonly sessionId: string
  readonly principalId: string
  readonly hostInstanceId: string
  readonly expiresAt: number
  readonly signal: AbortSignal
}

interface LeaseRecord {
  binding: PluginAuthorizationBinding
  lease: PluginLease
  abort: AbortController
}

export class PluginLeaseManager {
  private readonly leases = new Map<string, LeaseRecord>()
  private readonly unsubscribe: () => void
  private readonly timer: ReturnType<typeof setInterval>
  private readonly now: () => number
  private readonly ttlMs: number
  private disposed = false

  constructor(private readonly authorization: PluginAuthorization, options: { now?: () => number; ttlMs?: number } = {}) {
    this.now = options.now ?? Date.now
    this.ttlMs = Math.min(options.ttlMs ?? PLUGIN_LEASE_TTL_MS, PLUGIN_LEASE_TTL_MS)
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) throw new Error("Invalid plugin lease options")
    this.unsubscribe = authorization.onRevoked((sessionId) => this.revokeMatching({ sessionId }))
    this.timer = setInterval(() => this.sweep(), 1000)
    this.timer.unref?.()
  }

  create(binding: PluginAuthorizationBinding, scope: PluginLeaseScope): PluginLease {
    if (this.disposed) return staleActivation()
    this.authorization.assertBinding(binding)
    if (!scope.pluginId || !/^[a-f0-9]{64}$/.test(scope.digest) || !scope.contextEpoch
      || !Number.isSafeInteger(scope.grantsRevision) || scope.grantsRevision < 0
      || !Number.isSafeInteger(scope.connectionRevision) || scope.connectionRevision < 0) throw new Error("Invalid plugin lease scope")
    this.sweep()
    if (this.leases.size >= MAX_LEASES) throw new PluginAuthorizationError(429, "RATE_LIMITED", "Too many plugin activations")
    const abort = new AbortController()
    const lease = Object.freeze({
      pluginId: scope.pluginId, digest: scope.digest, projectKey: scope.projectKey, workspacePath: scope.workspacePath ?? null, contextEpoch: scope.contextEpoch,
      grantsRevision: scope.grantsRevision, connectionRevision: scope.connectionRevision,
      id: randomBytes(32).toString("hex"), sessionId: binding.sessionId,
      principalId: binding.principalId, hostInstanceId: binding.hostInstanceId,
      expiresAt: Math.min(binding.expiresAt, this.now() + this.ttlMs), signal: abort.signal,
    })
    this.leases.set(lease.id, { binding, lease, abort })
    return lease
  }

  resolve(binding: PluginAuthorizationBinding, id: string): PluginLease {
    this.authorization.assertBinding(binding)
    const record = this.leases.get(id)
    if (this.disposed || !record || record.binding !== binding) return staleActivation()
    if (record.lease.expiresAt <= this.now() || record.abort.signal.aborted) {
      this.remove(id)
      return staleActivation()
    }
    return record.lease
  }

  renew(binding: PluginAuthorizationBinding, id: string): PluginLease {
    const lease = this.resolve(binding, id)
    const record = this.leases.get(id)!
    record.lease = Object.freeze({ ...lease, expiresAt: Math.min(binding.expiresAt, this.now() + this.ttlMs) })
    return record.lease
  }

  revoke(binding: PluginAuthorizationBinding, id: string): void {
    this.resolve(binding, id)
    this.remove(id)
  }

  revokeMatching(scope: Partial<PluginLeaseScope> & { sessionId?: string }): void {
    const pairs = Object.entries(scope)
    for (const [id, { lease }] of this.leases) {
      if (pairs.every(([key, value]) => lease[key as keyof PluginLease] === value)) this.remove(id)
    }
  }

  private remove(id: string): void {
    const record = this.leases.get(id)
    if (!record) return
    this.leases.delete(id)
    record.abort.abort()
  }

  private sweep(): void {
    for (const [id, record] of this.leases) {
      try { this.resolve(record.binding, id) } catch { this.remove(id) }
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    clearInterval(this.timer)
    this.unsubscribe()
    for (const id of [...this.leases.keys()]) this.remove(id)
  }
}
