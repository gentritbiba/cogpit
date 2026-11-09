import { authFetch, authUrl } from "./auth"
import { getActiveDeviceScope, getActiveIdentity } from "./device"
import type { CommandReceipt, Conversation } from "../../shared/contracts/orchestration"

/** `commands` holds the conversation's commands that are not completed or cancelled, plus any `watch`ed ones. */
export interface ConversationState { conversation: Conversation | null; commands: CommandReceipt[]; freshness: "waiting" | "current" | "stale"; error?: string; currentAddress?: { dirName: string; fileName: string }; pendingTransition?: { id: string; sessionId?: string } | null }
export const EMPTY_CONVERSATION: ConversationState = { conversation: null, commands: [], freshness: "waiting" }
const states = new Map<string, ConversationStateOwner>()

class ConversationStateOwner {
  state = EMPTY_CONVERSATION
  private readonly listeners = new Set<() => void>()
  private timer?: ReturnType<typeof setTimeout>
  private pending?: AbortController
  private attempts = 0
  private stopped = false
  private etag?: string
  private readonly watchedIds = new Set<string>()
  private readonly identityChanged = () => { this.stopped = true; clearTimeout(this.timer); this.pending?.abort(); this.apply({ ...EMPTY_CONVERSATION, freshness: "stale", error: "Account or device changed" }); states.delete(this.key) }
  private readonly refresh = () => { if (document.visibilityState !== "hidden") void this.fetch() }
  constructor(readonly key: string, readonly url: string) {}
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1) {
      window.addEventListener("cogpit-command-accepted", this.refresh)
      window.addEventListener("online", this.refresh)
      window.addEventListener("cogpit-identity-changed", this.identityChanged)
      window.addEventListener("cogpit-device-scope-changed", this.identityChanged)
      document.addEventListener("visibilitychange", this.refresh)
      void this.fetch()
    }
    return () => {
      this.listeners.delete(listener)
      if (!this.listeners.size) {
        clearTimeout(this.timer); this.pending?.abort()
        window.removeEventListener("cogpit-command-accepted", this.refresh)
        window.removeEventListener("online", this.refresh)
        window.removeEventListener("cogpit-identity-changed", this.identityChanged)
        window.removeEventListener("cogpit-device-scope-changed", this.identityChanged)
        document.removeEventListener("visibilitychange", this.refresh)
        states.delete(this.key)
      }
    }
  }
  snapshot = (): ConversationState => this.state
  get watched(): boolean { return this.listeners.size > 0 }
  admit(receipt: CommandReceipt): void {
    if (this.state.commands.some((command) => command.id === receipt.id)) return
    this.etag = undefined
    this.apply({ ...this.state, commands: [...this.state.commands, receipt] })
  }
  /** Keeps `commandId` in `commands` after it completes or is cancelled, until the returned function is called. */
  watch(commandId: string): () => void {
    this.watchedIds.add(commandId)
    return () => { this.watchedIds.delete(commandId) }
  }
  private apply(state: ConversationState): void {
    if (sameJson(this.state, state)) return
    this.state = sameJson(this.state.commands, state.commands) ? { ...state, commands: this.state.commands } : state
    for (const listener of this.listeners) listener()
  }
  private async fetch(): Promise<void> {
    if (this.stopped || this.pending || !this.listeners.size || document.visibilityState === "hidden") return
    clearTimeout(this.timer)
    const controller = new AbortController(); this.pending = controller
    let denied = false
    try {
      const etag = this.etag
      const url = [this.url, ...[...this.watchedIds].map((id) => `commandId=${encodeURIComponent(id)}`)].join("&")
      const response = await authFetch(url, { signal: controller.signal, headers: etag ? { "If-None-Match": etag } : undefined })
      if (response.status === 304) {
        if (etag && etag === this.etag) this.apply({ ...this.state, freshness: "current", error: undefined })
        this.attempts = 0
        return
      }
      if (!response.ok) { denied = [401, 403, 404].includes(response.status); throw new Error(`Queue unavailable (${response.status})`) }
      const data = await response.json() as { conversation: Conversation; commands: CommandReceipt[]; currentAddress?: ConversationState["currentAddress"]; pendingTransition?: ConversationState["pendingTransition"] }
      if (controller.signal.aborted) return
      if (!data.conversation || !Array.isArray(data.commands)) throw new Error("Invalid queue snapshot")
      this.apply({ conversation: data.conversation, commands: data.commands, freshness: "current", currentAddress: data.currentAddress, pendingTransition: data.pendingTransition })
      this.etag = response.headers.get("ETag") ?? undefined
      this.attempts = 0
    } catch (error) {
      if (!controller.signal.aborted) {
        if (denied) this.etag = undefined
        this.apply({ ...(denied ? EMPTY_CONVERSATION : this.state), freshness: "stale", error: error instanceof Error ? error.message : "Queue unavailable" })
      }
      this.attempts++
    } finally {
      this.pending = undefined
      if (!this.stopped && this.listeners.size && !denied) this.timer = setTimeout(() => { void this.fetch() }, Math.min(30000, 2000 * 2 ** Math.min(this.attempts, 4)) * (0.8 + Math.random() * 0.4))
    }
  }
  async action(body: Record<string, unknown>): Promise<void> {
    if (this.stopped) throw new Error("Account or device changed; reopen the conversation")
    const response = await authFetch(this.url.split("?")[0]!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    if (!response.ok) { const result = await response.json() as { error?: string }; throw new Error(result.error ?? "Queue update failed") }
    await this.fetch()
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>
  for (const key in left) if (!sameJson(left[key], right[key])) return false
  for (const key in right) if (!(key in left) && right[key] !== undefined) return false
  return true
}

function ownerAddress(sessionId: string): { key: string; url: string } {
  const url = authUrl(`/api/session-commands?sessionId=${encodeURIComponent(sessionId)}`)
  return { key: JSON.stringify([getActiveDeviceScope(), getActiveIdentity(), url]), url }
}

export function conversationStateFor(sessionId: string): ConversationStateOwner {
  const { key, url } = ownerAddress(sessionId)
  let owner = states.get(key)
  if (!owner) { owner = new ConversationStateOwner(key, url); states.set(key, owner) }
  return owner
}

/** Hands an accepted command to a watched queue before its next fetch; false when no view watches that session. */
export function admitReceipt(receipt: CommandReceipt): boolean {
  const owner = states.get(ownerAddress(receipt.sessionId).key)
  if (!owner?.watched) return false
  owner.admit(receipt)
  return true
}
