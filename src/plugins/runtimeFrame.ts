import {
  CONTRACT_LIMITS, ERROR_CODES, parseFrameMessage, parseJson, parseMethodResult, parsePluginContext,
  type JsonValue, type PluginContext, type PluginError, type PluginRequest,
} from "@cogpit/plugin-contracts"
import { prepareRuntimePackage, type PreparedRuntimePackage } from "./runtimePayload"

export const RUNTIME_SHELL_PATH = "/api/plugins/shell/v1"
const READY_TIMEOUT_MS = 10000
const MESSAGE_RATE = 120

export interface RuntimeFrameOptions {
  frame: HTMLIFrameElement
  payload: ArrayBuffer
  digest: string
  context: PluginContext
  active?: boolean
  execute: (request: PluginRequest, signal: AbortSignal) => Promise<JsonValue>
  onReady?: () => void
  onError?: (error: Error) => void
  onDispose?: () => void
  crypto?: Crypto
  createChannel?: () => MessageChannel
  now?: () => number
}
export interface RuntimeFrameController {
  dispose(): void
  setActive(active: boolean): void
  updateContext(context: PluginContext): void
}

export function createRuntimeFrame(options: RuntimeFrameOptions): RuntimeFrameController {
  const { frame } = options
  const cryptoApi = options.crypto ?? globalThis.crypto
  const now = options.now ?? (() => performance.now())
  let context = parsePluginContext(options.context)
  let active = options.active ?? true
  let disposed = false
  let loaded = false
  let connected = false
  let delivered = false
  let readyRequested = false
  let readyRequestId: string | undefined
  let channel: MessageChannel | undefined
  let nonce = ""
  let prepared: PreparedRuntimePackage | undefined
  let windowStart = now()
  let messageCount = 0
  const pending = new Map<string, AbortController>()
  let timer = setTimeout(() => fail(new Error("Plugin runtime shell did not load")), READY_TIMEOUT_MS)

  const post = (value: unknown, transfer?: Transferable[]) => {
    if (disposed || !channel) return
    try { channel.port1.postMessage(value, transfer ?? []) }
    catch { fail(new Error("Plugin message channel became unavailable")) }
  }
  const cancelAll = (includeReady = true, notify = false) => {
    for (const [id, controller] of pending) {
      if (!includeReady && id === readyRequestId) continue
      controller.abort(); pending.delete(id)
      if (notify) respondError(id, "CANCELED", "Plugin request was canceled")
    }
  }
  function dispose(): void {
    if (disposed) return
    disposed = true
    clearTimeout(timer)
    cancelAll()
    frame.removeEventListener("load", load)
    if (channel) {
      try { channel.port1.postMessage({ protocol: 1, type: "event", event: "dispose", value: null }) } catch { /* Navigation can close the channel first. */ }
      channel.port1.removeEventListener("message", receive)
      channel.port1.removeEventListener("messageerror", messageError)
      channel.port1.close(); channel.port2.close()
    }
    frame.removeAttribute("src")
    options.onDispose?.()
  }
  function fail(error: Error): void {
    if (disposed) return
    dispose()
    options.onError?.(error)
  }
  function deliver(): void {
    if (disposed || !connected || !prepared || delivered) return
    delivered = true
    clearTimeout(timer)
    timer = setTimeout(() => fail(new Error("Plugin did not become ready within 10 seconds")), READY_TIMEOUT_MS)
    const assets = prepared.assets.map((asset) => ({ ...asset, bytes: asset.bytes.slice(0) }))
    post({ type: "cogpit-plugin-load", entry: prepared.entry, style: prepared.style, assets, context: { ...context, visible: active } }, assets.map((asset) => asset.bytes))
  }
  function load(): void {
    if (disposed) return
    if (loaded) { fail(new Error("Plugin frame navigated or reloaded")); return }
    loaded = true
    if (!frame.contentWindow || !cryptoApi?.subtle) { fail(new Error("Plugin runtime requires a secure browser connection")); return }
    try {
      nonce = Array.from(cryptoApi.getRandomValues(new Uint8Array(32)), (value) => value.toString(16).padStart(2, "0")).join("")
      channel = (options.createChannel ?? (() => new MessageChannel()))()
      channel.port1.addEventListener("message", receive)
      channel.port1.addEventListener("messageerror", messageError)
      channel.port1.start()
      frame.contentWindow.postMessage({ type: "cogpit-plugin-connect", nonce }, "*", [channel.port2])
    } catch { fail(new Error("Unable to connect the plugin runtime")) }
  }
  function messageError(): void { fail(new Error("Plugin sent an unreadable message")) }
  function respondError(id: string, code: PluginError["code"], message: string): void {
    post({ protocol: 1, type: "error", id, error: { code, message } })
  }
  async function execute(request: PluginRequest): Promise<void> {
    if (pending.has(request.id) || pending.size >= CONTRACT_LIMITS.outstandingRequests) { fail(new Error("Plugin exceeded its outstanding request limit")); return }
    if (request.method === "lifecycle.ready") {
      if (readyRequested) { fail(new Error("Plugin signaled readiness more than once")); return }
      readyRequested = true
      readyRequestId = request.id
    } else if (!active) { respondError(request.id, "RATE_LIMITED", "Plugin panel is hidden"); return }
    const controller = new AbortController()
    pending.set(request.id, controller)
    try {
      const value = parseMethodResult(request.method, await options.execute(request, controller.signal))
      if (disposed || controller.signal.aborted || pending.get(request.id) !== controller) return
      post(parseFrameMessage({ protocol: 1, type: "result", id: request.id, value }))
      if (disposed) return
      if (request.method === "lifecycle.ready") {
        clearTimeout(timer)
        options.onReady?.()
      }
    } catch (error) {
      if (disposed || controller.signal.aborted) return
      const candidate = error && typeof error === "object" && "code" in error ? error.code : null
      const code = ERROR_CODES.includes(candidate as PluginError["code"]) ? candidate as PluginError["code"] : "UPSTREAM_FAILED"
      respondError(request.id, code, "The host could not complete this operation")
      if (request.method === "lifecycle.ready") fail(new Error("Host refused plugin readiness"))
    } finally {
      if (pending.get(request.id) === controller) pending.delete(request.id)
    }
  }
  function receive(event: MessageEvent<unknown>): void {
    if (disposed) return
    if (now() - windowStart >= 1000) { windowStart = now(); messageCount = 0 }
    if (++messageCount > MESSAGE_RATE) { fail(new Error("Plugin exceeded its message rate limit")); return }
    try {
      const data = parseJson(event.data)
      if (!connected) {
        if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).length !== 2 || data.type !== "cogpit-plugin-connected" || data.nonce !== nonce) throw new Error("Invalid plugin handshake")
        connected = true; deliver(); return
      }
      if (data && typeof data === "object" && !Array.isArray(data) && Object.keys(data).length === 1 && data.type === "cogpit-plugin-load-error") throw new Error("Plugin entry failed to load")
      if (!delivered) throw new Error("Plugin sent a request before activation")
      const message = parseFrameMessage(data)
      if (message.type === "cancel") {
        pending.get(message.id)?.abort(); pending.delete(message.id); return
      }
      if (message.type !== "request") throw new Error("Invalid plugin message direction")
      void execute(message)
    } catch (error) { fail(error instanceof Error ? error : new Error("Invalid plugin message")) }
  }
  void prepareRuntimePackage(options.payload, options.digest, cryptoApi).then((value) => {
    if (disposed) return
    prepared = value; deliver()
  }).catch((error: unknown) => fail(error instanceof Error ? error : new Error("Plugin package could not be loaded")))
  frame.addEventListener("load", load)
  frame.src = RUNTIME_SHELL_PATH
  return {
    dispose,
    setActive(value) {
      if (disposed || active === value) return
      active = value
      if (!active) cancelAll(false, true)
      if (delivered) post({ protocol: 1, type: "event", event: "visibility", value: active })
    },
    updateContext(value) {
      if (disposed) return
      const next = parsePluginContext(value)
      if (JSON.stringify(next.project) !== JSON.stringify(context.project)) { dispose(); return }
      if (JSON.stringify(next) === JSON.stringify(context)) return
      const old = context
      context = next
      if (!delivered) return
      if (old.locale !== next.locale || old.reducedMotion !== next.reducedMotion) {
        cancelAll(false, true); post({ protocol: 1, type: "event", event: "context", value: { ...next, visible: active } })
      } else {
        if (old.session?.handle !== next.session?.handle) post({ protocol: 1, type: "event", event: "session", value: next.session ?? null })
        if (JSON.stringify(old.theme) !== JSON.stringify(next.theme)) post({ protocol: 1, type: "event", event: "theme", value: next.theme })
      }
    },
  }
}
