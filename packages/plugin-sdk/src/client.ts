import {
  CONTRACT_LIMITS, ContractValidationError, parseFrameMessage, parseMethodResult, parsePluginContext,
  type FrameMessage, type JsonValue, type MethodMap, type PluginContext, type PluginError, type PluginMethod, type PluginIntegrationRequest,
} from "@cogpit/plugin-contracts"

export interface RequestOptions { signal?: AbortSignal }
export class PluginRequestError extends Error {
  constructor(readonly code: PluginError["code"], message: string) { super(message); this.name = "PluginRequestError" }
}
export interface PluginClientOptions { port: MessagePort; context: PluginContext; timeoutMs?: number }
export interface PluginClient {
  readonly context: Readonly<PluginContext>
  ready(): Promise<null>
  integrations: { request(input: PluginIntegrationRequest, options?: RequestOptions): Promise<MethodMap["integrations.request"]["result"]> }
  connections: {
    status(handle: string, options?: RequestOptions): Promise<MethodMap["connections.status"]["result"]>
    request(handle: string, operationId: string, args: Record<string, string | number | boolean>, options?: RequestOptions): Promise<JsonValue>
  }
  storage: {
    get(key: string, options?: RequestOptions): Promise<JsonValue>
    set(key: string, value: JsonValue, options?: RequestOptions): Promise<null>
    delete(key: string, options?: RequestOptions): Promise<null>
  }
  composer: { append(text: string, options?: RequestOptions): Promise<null> }
  navigation: {
    openExternal(url: string, options?: RequestOptions): Promise<null>
    openSession(handle: string, options?: RequestOptions): Promise<null>
  }
  onContextChange(listener: (context: Readonly<PluginContext>) => void): () => void
  onThemeChange(listener: (theme: Readonly<PluginContext["theme"]>) => void): () => void
  onVisibilityChange(listener: (visible: boolean) => void): () => void
  dispose(): void
}

interface PendingRequest {
  method: PluginMethod
  resolve(value: unknown): void
  reject(error: Error): void
  cleanup(): void
}

function immutableContext(value: unknown): PluginContext {
  const context = parsePluginContext(value)
  if (context.project) Object.freeze(context.project)
  Object.freeze(context.theme.tokens)
  Object.freeze(context.theme)
  return Object.freeze(context)
}

export function createPluginClient({ port, context: initialContext, timeoutMs = CONTRACT_LIMITS.requestTimeoutMs }: PluginClientOptions): PluginClient {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CONTRACT_LIMITS.requestTimeoutMs) {
    throw new ContractValidationError([{ path: "$.timeoutMs", message: "Invalid request timeout" }])
  }
  let context = immutableContext(initialContext)
  let disposed = false
  let sequence = 0
  let readyPromise: Promise<null> | undefined
  const pending = new Map<string, PendingRequest>()
  const contextListeners = new Set<(value: Readonly<PluginContext>) => void>()
  const themeListeners = new Set<(value: Readonly<PluginContext["theme"]>) => void>()
  const visibilityListeners = new Set<(value: boolean) => void>()
  const post = (message: FrameMessage) => port.postMessage(message)
  const cancel = (id: string, error: PluginRequestError) => {
    const request = pending.get(id)
    if (!request) return
    pending.delete(id)
    request.cleanup()
    try { post({ protocol: 1, type: "cancel", id }) } catch { /* The port may already be closed. */ }
    request.reject(error)
  }
  const cancelAll = (error: PluginRequestError) => {
    for (const id of pending.keys()) cancel(id, error)
  }

  function request<M extends PluginMethod>(method: M, params: MethodMap[M]["params"], options: RequestOptions = {}): Promise<MethodMap[M]["result"]> {
    if (disposed) return Promise.reject(new PluginRequestError("DISPOSED", "Plugin client is disposed"))
    if (options.signal?.aborted) return Promise.reject(new PluginRequestError("CANCELED", "Request canceled"))
    if (pending.size >= CONTRACT_LIMITS.outstandingRequests) return Promise.reject(new PluginRequestError("RATE_LIMITED", "Too many outstanding requests"))
    const id = `r_${++sequence}`
    let message: FrameMessage
    try { message = parseFrameMessage({ protocol: 1, type: "request", id, method, params }) }
    catch (error) { return Promise.reject(error) }
    return new Promise((resolve, reject) => {
      const abort = () => cancel(id, new PluginRequestError("CANCELED", "Request canceled"))
      const timeout = setTimeout(() => cancel(id, new PluginRequestError("TIMEOUT", "Request timed out")), timeoutMs)
      const cleanup = () => { clearTimeout(timeout); options.signal?.removeEventListener("abort", abort) }
      pending.set(id, { method, resolve: (value) => resolve(value as MethodMap[M]["result"]), reject, cleanup })
      options.signal?.addEventListener("abort", abort, { once: true })
      try { post(message) } catch {
        pending.delete(id)
        cleanup()
        reject(new PluginRequestError("DISPOSED", "Message channel is unavailable"))
      }
    })
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    cancelAll(new PluginRequestError("DISPOSED", "Plugin client is disposed"))
    port.removeEventListener("message", receive)
    port.removeEventListener("messageerror", transportError)
    contextListeners.clear(); themeListeners.clear(); visibilityListeners.clear()
    port.close()
  }
  const notify = <T>(listeners: Set<(value: T) => void>, value: T) => {
    for (const listener of listeners) queueMicrotask(() => { if (!disposed && listeners.has(listener)) listener(value) })
  }
  function receive(event: MessageEvent<unknown>): void {
    if (disposed) return
    let message: FrameMessage
    try { message = parseFrameMessage(event.data) } catch { dispose(); return }
    if (message.type === "result" || message.type === "error") {
      const current = pending.get(message.id)
      if (!current) return
      pending.delete(message.id); current.cleanup()
      if (message.type === "error") current.reject(new PluginRequestError(message.error.code, message.error.message))
      else {
        try { current.resolve(parseMethodResult(current.method, message.value)) }
        catch { current.reject(new PluginRequestError("INVALID_RESPONSE", "Host returned an invalid response")) }
      }
      return
    }
    if (message.type !== "event") { dispose(); return }
    if (message.event === "dispose") { dispose(); return }
    if (message.event === "context") {
      cancelAll(new PluginRequestError("STALE_ACTIVATION", "Plugin context changed"))
      context = immutableContext(message.value)
      notify(contextListeners, context)
      notify(themeListeners, context.theme)
      notify(visibilityListeners, context.visible)
    } else if (message.event === "theme") {
      context = immutableContext({ ...context, theme: message.value })
      notify(themeListeners, context.theme)
    } else if (message.event === "session") {
      context = immutableContext({ ...context, session: message.value })
      notify(contextListeners, context)
    } else {
      context = immutableContext({ ...context, visible: message.value })
      notify(visibilityListeners, context.visible)
    }
  }
  function transportError(): void { dispose() }
  const subscribe = <T>(listeners: Set<(value: T) => void>, listener: (value: T) => void) => {
    if (disposed) throw new PluginRequestError("DISPOSED", "Plugin client is disposed")
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  port.addEventListener("message", receive)
  port.addEventListener("messageerror", transportError)
  port.start()
  return Object.freeze({
    get context() { return context },
    ready: () => {
      if (disposed) return Promise.reject(new PluginRequestError("DISPOSED", "Plugin client is disposed"))
      readyPromise ??= request("lifecycle.ready", {})
      return readyPromise
    },
    integrations: Object.freeze({ request: (input: PluginIntegrationRequest, options?: RequestOptions) => request("integrations.request", input, options) }),
    connections: Object.freeze({
      status: (handle: string, options?: RequestOptions) => request("connections.status", { handle }, options),
      request: (handle: string, operationId: string, args: Record<string, string | number | boolean>, options?: RequestOptions) => request("connections.request", { handle, operationId, args }, options),
    }),
    storage: Object.freeze({
      get: (key: string, options?: RequestOptions) => request("storage.get", { key }, options),
      set: (key: string, value: JsonValue, options?: RequestOptions) => request("storage.set", { key, value }, options),
      delete: (key: string, options?: RequestOptions) => request("storage.delete", { key }, options),
    }),
    composer: Object.freeze({ append: (text: string, options?: RequestOptions) => request("composer.append", { text }, options) }),
    navigation: Object.freeze({
      openExternal: (url: string, options?: RequestOptions) => request("navigation.openExternal", { url }, options),
      openSession: (handle: string, options?: RequestOptions) => request("navigation.openSession", { handle }, options),
    }),
    onContextChange: (listener: (value: Readonly<PluginContext>) => void) => subscribe(contextListeners, listener),
    onThemeChange: (listener: (value: Readonly<PluginContext["theme"]>) => void) => subscribe(themeListeners, listener),
    onVisibilityChange: (listener: (value: boolean) => void) => subscribe(visibilityListeners, listener),
    dispose,
  })
}
