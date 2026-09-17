import type { JsonValue, PluginRequest } from "@cogpit/plugin-contracts"
import type { RuntimeLease, RuntimePluginClient } from "./runtimeClient"

export type RuntimePanelClient = Pick<RuntimePluginClient, "lease" | "payload" | "renewLease" | "revokeLease" | "call"> & Partial<Pick<RuntimePluginClient, "resolveSession">>
export interface RuntimePanelActivation {
  execute(request: PluginRequest, signal: AbortSignal): Promise<JsonValue>
  setActive(active: boolean): void
  resetSession(): void
  fail(error: Error): void
  dispose(): void
}

export function createRuntimePanelActivation(options: {
  client: RuntimePanelClient
  pluginId: string
  digest: string
  workspacePath?: string | null
  projectId: string | null
  contextEpoch: string
  active: boolean
  onLoaded(payload: ArrayBuffer, leaseId: string): void
  onError(error: Error): void
  openSession?: (dirName: string, fileName: string) => void
  appendDraft?: (text: string) => void
  openExternal?: (url: string, signal: AbortSignal) => Promise<void>
}): RuntimePanelActivation {
  const controller = new AbortController()
  let requests = new AbortController()
  let sessionActions = new AbortController()
  let active = options.active
  let lease: RuntimeLease | undefined
  let renewalTimer: ReturnType<typeof setTimeout> | undefined
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  let lastDraftAppend = -Infinity
  let lastExternalOpen = -Infinity
  const revoke = (id: string) => { void options.client.revokeLease(id).catch(() => {}) }
  function dispose() {
    if (controller.signal.aborted) return
    controller.abort()
    requests.abort()
    sessionActions.abort()
    clearTimeout(renewalTimer)
    clearTimeout(expiryTimer)
    if (lease) revoke(lease.id)
  }
  function fail(error: Error) {
    if (controller.signal.aborted) return
    dispose()
    options.onError(error)
  }
  function scheduleRenewal() {
    if (!lease || controller.signal.aborted) return
    const remaining = lease.expiresAt - Date.now()
    if (remaining <= 0) { fail(new Error("Plugin activation expired")); return }
    clearTimeout(expiryTimer)
    expiryTimer = setTimeout(() => fail(new Error("Plugin activation expired")), remaining)
    renewalTimer = setTimeout(() => { void renew() }, Math.min(8000, Math.max(1, Math.floor(remaining / 2))))
  }
  async function renew() {
    if (!lease || controller.signal.aborted) return
    try {
      const renewed = await options.client.renewLease(lease.id, controller.signal)
      if (controller.signal.aborted) return
      if (renewed.id !== lease.id) { revoke(renewed.id); throw new Error("Plugin activation changed during renewal") }
      lease = renewed
      scheduleRenewal()
    } catch { fail(new Error("Plugin activation could not be renewed")) }
  }
  const granted = options.client.lease(options.pluginId, options.projectId, options.contextEpoch, controller.signal, options.workspacePath).then((value) => {
    if (controller.signal.aborted) { revoke(value.id); return }
    lease = value
    scheduleRenewal()
  })
  void Promise.all([granted, options.client.payload(options.digest, controller.signal)]).then(([, payload]) => {
    if (!controller.signal.aborted && lease) options.onLoaded(payload, lease.id)
  }).catch(() => fail(new Error("Plugin panel could not be loaded")))
  return {
    async execute(request, signal) {
      const sessionAction = request.method === "composer.append" || request.method.startsWith("navigation.")
      const combined = AbortSignal.any([signal, controller.signal, ...(request.method === "lifecycle.ready" ? [] : [requests.signal]), ...(sessionAction ? [sessionActions.signal] : [])])
      combined.throwIfAborted()
      if (!lease || lease.expiresAt <= Date.now()) throw new Error("Plugin activation expired")
      if (!active && request.method !== "lifecycle.ready") throw new Error("Plugin panel is hidden")
      if (request.method === "composer.append" && !options.appendDraft) {
        throw Object.assign(new Error("The message composer is unavailable"), { code: "CAPABILITY_UNAVAILABLE" })
      }
      if (request.method === "navigation.openExternal" && !options.openExternal) {
        throw Object.assign(new Error("External navigation is unavailable"), { code: "CAPABILITY_UNAVAILABLE" })
      }
      if (request.method === "navigation.openSession" && (!options.openSession || !options.client.resolveSession)) {
        throw Object.assign(new Error("Session navigation is unavailable"), { code: "CAPABILITY_UNAVAILABLE" })
      }
      const result = await options.client.call(lease.id, request, combined)
      combined.throwIfAborted()
      if (request.method === "composer.append") {
        if (performance.now() - lastDraftAppend < 1000) throw Object.assign(new Error("Wait before adding another draft"), { code: "RATE_LIMITED" })
        lastDraftAppend = performance.now()
        options.appendDraft!(request.params.text)
      }
      if (request.method === "navigation.openExternal") {
        if (performance.now() - lastExternalOpen < 1000) throw Object.assign(new Error("Wait before opening another link"), { code: "RATE_LIMITED" })
        lastExternalOpen = performance.now()
        await options.openExternal!(request.params.url, combined)
        combined.throwIfAborted()
      }
      if (request.method === "navigation.openSession") {
        if (performance.now() - lastExternalOpen < 1000) throw Object.assign(new Error("Wait before opening another session"), { code: "RATE_LIMITED" })
        lastExternalOpen = performance.now()
        const address = await options.client.resolveSession!(lease.id, request.params.handle, combined)
        combined.throwIfAborted()
        options.openSession!(address.dirName, address.fileName)
      }
      return result
    },
    setActive(value) {
      if (active === value) return
      active = value
      requests.abort()
      requests = new AbortController()
    },
    resetSession() {
      sessionActions.abort()
      sessionActions = new AbortController()
    },
    fail,
    dispose,
  }
}
