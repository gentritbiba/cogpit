import { useCallback, useEffect, useSyncExternalStore } from "react"
import type { CloudflareAccountWorker } from "@cogpit/plugin-integrations"

export interface AccountSelection { id: string; name: string }
export type AccountErrorCode = "cloudflare_not_connected" | "cloudflare_account_unselected" | "cloudflare_api_failed" | "invalid_response"
export interface AccountError { code: AccountErrorCode; error: string }
export interface AccountState {
  account: AccountSelection | null
  workers: CloudflareAccountWorker[] | null
  error: AccountError | null
  loading: boolean
  refreshing: boolean
}
/** The two host calls the Account tab needs: the connection status and the declared `workers` operation. */
export interface AccountClient {
  status: (signal: AbortSignal) => Promise<unknown>
  workers: (signal: AbortSignal) => Promise<unknown>
}
const EMPTY_STATE: AccountState = { account: null, workers: null, error: null, loading: false, refreshing: false }
const CACHE_WINDOW_MS = 8_000
const POLL_INTERVAL_MS = 60_000
const SETUP_ERROR_CODES = new Set<AccountErrorCode>(["cloudflare_not_connected", "cloudflare_account_unselected"])

const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
const text = (value: unknown): string | null => typeof value === "string" && value ? value : null
const timestamp = (value: unknown): string | null => { const value_ = text(value); return value_ && Number.isFinite(Date.parse(value_)) ? value_ : null }

export function parseAccountStatus(value: unknown): AccountSelection | null | undefined {
  const status = object(value)
  if (!status || typeof status.configured !== "boolean") throw { code: "invalid_response", error: "Invalid connection status" }
  if (!status.configured) return undefined
  const account = object(object(status.selected)?.account)
  return account && text(account.id) ? { id: String(account.id), name: text(account.label) ?? String(account.id) } : null
}

/** `GET /accounts/:id/workers/scripts` returns `{ result: [...] }`; keep the fields the list shows and nothing script-specific. */
export function parseAccountWorkers(value: unknown, account: AccountSelection): CloudflareAccountWorker[] {
  const body = object(value)
  if (!body || !Array.isArray(body.result)) throw { code: "invalid_response", error: "Cloudflare returned an invalid Workers list" }
  return body.result.flatMap((entry): CloudflareAccountWorker[] => {
    const script = object(entry)
    const name = text(script?.id)
    if (!script || !name) return []
    return [{
      name,
      createdAt: timestamp(script.created_on),
      modifiedAt: timestamp(script.modified_on),
      handlers: Array.isArray(script.handlers) ? script.handlers.filter((handler): handler is string => typeof handler === "string") : [],
      usageModel: text(script.usage_model),
      lastDeployedFrom: text(script.last_deployed_from),
      dashboardUrl: `https://dash.cloudflare.com/${account.id}/workers/services/view/${encodeURIComponent(name)}/production`,
    }]
  }).sort((left, right) => (right.modifiedAt ?? "").localeCompare(left.modifiedAt ?? "") || left.name.localeCompare(right.name))
}

function failure(error: unknown): AccountError {
  const detail = object(error)
  const code = text(detail?.code)
  if (code === "CONNECTION_REQUIRED" || code === "cloudflare_not_connected") return { code: "cloudflare_not_connected", error: "Connect Cloudflare with an API token in Connections above this panel." }
  if (code === "RESOURCE_REQUIRED" || code === "cloudflare_account_unselected") return { code: "cloudflare_account_unselected", error: "Choose an account in Connections above this panel." }
  if (code === "invalid_response") return { code, error: text(detail?.error) ?? "Cloudflare returned an unexpected response." }
  return { code: "cloudflare_api_failed", error: "Unable to list Workers for this account." }
}

export function createAccountStore(client: AccountClient) {
  const listeners = new Set<() => void>()
  const lifetime = new AbortController()
  let snapshot = EMPTY_STATE
  let request: Promise<void> | null = null
  let fetchedAt = 0
  function publish(next: AccountState): void {
    if (lifetime.signal.aborted) return
    snapshot = next
    for (const listener of listeners) listener()
  }
  async function load(force = false): Promise<void> {
    if (lifetime.signal.aborted) return
    if (request) return request
    if (!force && snapshot.error && SETUP_ERROR_CODES.has(snapshot.error.code)) return
    if (!force && fetchedAt > 0 && Date.now() - fetchedAt < CACHE_WINDOW_MS) return
    const retainedError = force ? null : snapshot.error
    publish({ ...snapshot, error: retainedError, loading: snapshot.workers === null && retainedError === null, refreshing: snapshot.workers !== null })
    const pending = Promise.resolve().then(async () => {
      lifetime.signal.throwIfAborted()
      const account = parseAccountStatus(await client.status(lifetime.signal))
      if (account === undefined) throw { code: "cloudflare_not_connected" }
      if (account === null) throw { code: "cloudflare_account_unselected" }
      lifetime.signal.throwIfAborted()
      const workers = parseAccountWorkers(await client.workers(lifetime.signal), account)
      lifetime.signal.throwIfAborted()
      fetchedAt = Date.now()
      publish({ account, workers, error: null, loading: false, refreshing: false })
    }).catch((error: unknown) => {
      fetchedAt = Date.now()
      publish({ ...snapshot, error: failure(error), loading: false, refreshing: false })
    }).finally(() => { if (request === pending) request = null })
    request = pending
    return pending
  }
  return {
    load,
    subscribe(listener: () => void): () => void {
      if (lifetime.signal.aborted) return () => {}
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    snapshot(): AccountState { return snapshot },
    dispose() { lifetime.abort(); listeners.clear() },
  }
}
export type AccountStore = ReturnType<typeof createAccountStore>

export function useAccountWorkers(store: AccountStore | null, enabled: boolean) {
  const state = useSyncExternalStore(
    useCallback(listener => store ? store.subscribe(listener) : () => {}, [store]),
    useCallback(() => store ? store.snapshot() : EMPTY_STATE, [store]),
    () => EMPTY_STATE,
  )
  useEffect(() => {
    if (!enabled || !store) return
    void store.load()
    const interval = window.setInterval(() => { void store.load() }, POLL_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [store, enabled])
  const refresh = useCallback(() => store ? store.load(true) : Promise.resolve(), [store])
  return { ...state, refresh }
}
