import { randomUUID } from "node:crypto"
import type { CommandReceipt } from "../../shared/contracts/orchestration"
import { OrchestrationStore, type DispatcherLease, type StoredCommand } from "./store"

export interface DispatchDelivery {
  delivery: "started" | "enqueued" | "steered" | "busy"
  turnId?: string
  completion?: Promise<{ isError: boolean; message?: string }>
}
export interface DispatchAuthority {
  authorize(command: StoredCommand): Promise<boolean>
  deliver(command: StoredCommand, currentAttempt: () => boolean): Promise<DispatchDelivery>
  activity(command: StoredCommand): { live: boolean; running: boolean }
}

export class CommandDispatcher {
  private readonly owner = randomUUID()
  private lease: DispatcherLease | null = null
  private timer?: ReturnType<typeof setInterval>
  private readonly authorities = new Map<string, DispatchAuthority>()
  private readonly active = new Map<string, StoredCommand>()
  private ticking = false
  private closed = false
  private readonly waiters = new Set<() => void>()

  constructor(readonly store: OrchestrationStore) {}
  start(): boolean {
    if (this.closed) return false
    this.lease = this.store.acquire(this.owner)
    if (!this.timer) { this.timer = setInterval(() => { void this.tick() }, 500); this.timer.unref() }
    return this.lease !== null
  }
  attach(scope: string, conversationId: string, authority: DispatchAuthority): void { this.authorities.set(JSON.stringify([scope, conversationId]), authority) }
  detach(scope: string, conversationId: string): void { this.authorities.delete(JSON.stringify([scope, conversationId])) }
  async tick(): Promise<void> {
    if (this.ticking || this.closed) return
    this.ticking = true
    try {
      this.lease = this.store.acquire(this.owner)
      const lease = this.lease
      if (!lease) { this.active.clear(); return }
      for (const [key, command] of this.active) {
        const authority = this.authorities.get(JSON.stringify([command.scope, command.receipt.conversationId]))
        if (!authority) continue
        const activity = authority.activity(command)
        if (!activity.live) {
          this.store.finish(command, lease, "unknown", { error: "Agent disconnected before reporting completion. Inspect native history." })
          this.active.delete(key)
        } else if (!activity.running) {
          this.store.finish(command, lease, "completed")
          this.active.delete(key)
        }
      }
      for (const candidate of this.store.pending()) {
        if (candidate.receipt.state !== "queued") continue
        const authority = this.authorities.get(JSON.stringify([candidate.scope, candidate.receipt.conversationId]))
        if (!authority) continue
        if (!await authority.authorize(candidate).catch(() => false)) {
          const claimed = this.store.claim(candidate.scope, candidate.receipt.id, lease)
          if (claimed) this.store.finish(claimed, lease, "held", { error: "Sign in with access to this session, then resume its queue." })
          continue
        }
        const activity = authority.activity(candidate)
        if (activity.running && candidate.receipt.intent === "queue") continue
        const command = this.store.claim(candidate.scope, candidate.receipt.id, lease)
        if (!command) continue
        // Provider I/O can take seconds; the heartbeat continues independently.
        void this.dispatch(command, lease, authority)
      }
    } catch (error) { if (!this.closed) console.error("[orchestration] dispatcher tick failed", error) } finally { this.ticking = false }
  }
  private async dispatch(command: StoredCommand, lease: DispatcherLease, authority: DispatchAuthority): Promise<void> {
    try {
      if (!await authority.authorize(command).catch(() => false)) { this.store.finish(command, lease, "held", { error: "Access changed before delivery" }); return }
      const currentAttempt = () => !this.closed && this.store.currentAttempt(command, lease)
      if (!currentAttempt()) return
      const outcome = await authority.deliver(command, currentAttempt)
      if (this.closed) return
      if (outcome.delivery === "busy") {
        this.store.finish(command, lease, "held", { error: "Agent is busy; review and resume the queue." })
        return
      }
      if (!this.store.finish(command, lease, "delivered", { delivery: outcome.delivery, turnId: outcome.turnId })) return
      if (outcome.completion) {
        const result = await outcome.completion
        if (!this.closed) this.store.finish(command, lease, result.isError ? "failed" : "completed", { error: result.isError ? result.message ?? "Turn failed" : undefined })
      } else this.active.set(JSON.stringify([command.scope, command.receipt.id]), command)
    } catch (error) {
      if (this.closed) return
      const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 0
      const errorCode = status === 400 && typeof error === "object" && error && "code" in error && error.code === "MODEL_REJECTED" ? "MODEL_REJECTED" : undefined
      this.store.finish(command, lease, [400, 403, 404].includes(status) ? "failed" : "unknown", { error: error instanceof Error ? error.message : "Agent delivery failed", errorCode })
    }
    void this.tick()
  }
  async wait(scope: string, id: string, timeoutMs = 90000): Promise<CommandReceipt | null> {
    const settled = new Set(["completed", "failed", "cancelled", "unknown", "held"])
    const current = this.store.command(scope, id)?.receipt
    if (!current || settled.has(current.state)) return current ?? null
    return new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); stop(); this.waiters.delete(finish); resolve(this.store.command(scope, id)?.receipt ?? null) }
      const stop = this.store.subscribe((event) => {
        if (event.type !== "command") return
        const receipt = this.store.command(scope, id)?.receipt
        if (receipt && settled.has(receipt.state)) finish()
      })
      const timer = setTimeout(finish, timeoutMs)
      this.waiters.add(finish)
    })
  }
  close(): void {
    for (const finish of this.waiters) finish()
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    if (this.lease) this.store.release(this.lease)
    this.authorities.clear(); this.active.clear()
  }
}
