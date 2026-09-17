import { CONTRACT_LIMITS, connectionResourceDependencies, parseConnectionDefinition, parseJson, utf8Length,
  type ConnectionDefinition, type ConnectionOperation, type JsonValue } from "@cogpit/plugin-contracts"
import type { PluginHttpsInput } from "./httpsTransport"

export const CONNECTION_LIMITS = Object.freeze({ options: 100, secretBytes: 4096, stringBytes: 1024 })
export interface ResourceSelection { id: string; label: string }
export interface ResourceOption { selection: ResourceSelection; parent?: ResourceSelection }
export interface ResolvedResourceInput { selection: ResourceSelection; parents: Record<string, string> }
export interface HostConnection {
  label: string
  secret: string
  selected: Record<string, ResourceSelection>
  identity?: Record<string, string>
}
export type ConnectionTransport = (request: PluginHttpsInput) => Promise<unknown>
export type ConnectionErrorCode = "INVALID_REQUEST" | "RESOURCE_REQUIRED" | "UPSTREAM_FAILED" | "INVALID_RESPONSE" | "CANCELED" | "TIMEOUT" | "NETWORK_DENIED"
export type ConnectionResult<T = JsonValue> = { ok: true; data: T } | { ok: false; error: ConnectionErrorCode }
export interface ConnectionExecutorOptions { transport: ConnectionTransport; allowedOperations: readonly string[]; signal?: AbortSignal }

class Rejected extends Error {
  constructor(readonly code: ConnectionErrorCode = "INVALID_REQUEST") { super(code) }
}
function deny(): never { throw new Rejected() }
function record(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return deny()
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) return deny()
  return value as Record<string, unknown>
}
function text(value: unknown, limit: number): string {
  if (typeof value !== "string" || !value.length || utf8Length(value) > limit
    || [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return deny()
  return value
}
function pathValue(value: unknown): string {
  const result = text(value, CONNECTION_LIMITS.stringBytes)
  if (result === "." || result === ".." || /[/%\\]/u.test(result)) return deny()
  return result
}
function responseId(value: unknown): string {
  return pathValue(typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value)
}
function containsSecret(value: JsonValue, secret: string): boolean {
  if (value === null || typeof value !== "object") return String(value).includes(secret)
  return Object.entries(value).some(([key, child]) => key.includes(secret) || containsSecret(child, secret))
}
function select(value: JsonValue, pointer: string): JsonValue {
  let selected = value
  for (const encoded of pointer === "" ? [] : pointer.slice(1).split("/")) {
    const key = encoded.replace(/~1/gu, "/").replace(/~0/gu, "~")
    if (!selected || typeof selected !== "object" || !Object.hasOwn(selected, key)) return deny()
    selected = (selected as Record<string, JsonValue>)[key]
  }
  return selected
}
function argsFor(operation: ConnectionOperation, value: unknown): Record<string, string | number | boolean> {
  const args = record(value, Object.entries(operation.args).filter(([, spec]) => spec.required).map(([key]) => key), Object.keys(operation.args))
  for (const [key, candidate] of Object.entries(args)) {
    const spec = operation.args[key]
    if (spec.type === "string") {
      const value = text(candidate, spec.maxLength)
      if (spec.enum && !spec.enum.includes(value)) deny()
    } else if (spec.type === "integer") {
      if (!Number.isSafeInteger(candidate) || (candidate as number) < spec.min || (candidate as number) > spec.max) deny()
    } else if (typeof candidate !== "boolean") deny()
  }
  return args as Record<string, string | number | boolean>
}
function resultError(error: unknown, fallback: ConnectionErrorCode): ConnectionResult<never> {
  if (error instanceof Rejected) return { ok: false, error: error.code }
  if (error instanceof Error && "code" in error && ["CANCELED", "TIMEOUT", "NETWORK_DENIED", "INVALID_RESPONSE"].includes(String(error.code))) {
    return { ok: false, error: error.code as ConnectionErrorCode }
  }
  return { ok: false, error: fallback }
}

export function createConnectionExecutor(rawDefinition: unknown, rawConnection: HostConnection, options: ConnectionExecutorOptions) {
  let definition: ConnectionDefinition
  let connection: HostConnection
  try {
    definition = parseConnectionDefinition(rawDefinition)
    const candidate = record(parseJson(rawConnection, { maxBytes: 32768 }), ["label", "secret", "selected"], ["identity"])
    const secret = text(candidate.secret, CONNECTION_LIMITS.secretBytes)
    if ([...secret].some((character) => character.charCodeAt(0) < 33 || character.charCodeAt(0) > 126)) deny()
    const label = text(candidate.label, 128)
    const selections = record(candidate.selected, [], Object.keys(definition.resources))
    const selected: Record<string, ResourceSelection> = Object.create(null)
    for (const [name, input] of Object.entries(selections)) {
      const item = record(input, ["id", "label"])
      selected[name] = { id: pathValue(item.id), label: text(item.label, 128) }
    }
    const bindings = record(candidate.identity ?? {}, [], Object.keys(definition.identity ?? {}))
    const identity: Record<string, string> = Object.create(null)
    for (const [name, input] of Object.entries(bindings)) identity[name] = pathValue(input)
    connection = { label, secret, selected, identity }
    if (containsSecret({ label, selected: selected as unknown as JsonValue, identity }, secret)) deny()
    if (!Array.isArray(options.allowedOperations) || options.allowedOperations.length > 32
      || options.allowedOperations.some((name) => !Object.hasOwn(definition.operations, name) || definition.operations[name].audience !== "panel")) deny()
  } catch { throw new Rejected() }
  const allowed = new Set(options.allowedOperations)
  const signal = options.signal ?? new AbortController().signal
  const transport = options.transport
  const canceled = () => { if (signal.aborted) throw new Rejected("CANCELED") }
  function requireResource(name: string): ResourceSelection {
    const selected = connection.selected[name]
    if (!selected) throw new Rejected("RESOURCE_REQUIRED")
    for (const parent of connectionResourceDependencies(definition, name)) requireResource(parent)
    return selected
  }
  function build(call: unknown, audience: "setup" | "panel"): PluginHttpsInput {
    canceled()
    const request = record(parseJson(call, { maxBytes: CONTRACT_LIMITS.argumentBytes }), ["operation", "args"])
    if (typeof request.operation !== "string" || !Object.hasOwn(definition.operations, request.operation)) return deny()
    const operation = definition.operations[request.operation]
    if (operation.audience !== audience || (audience === "panel" && !allowed.has(request.operation))) return deny()
    const args = argsFor(operation, request.args)
    const path = operation.path.map((part) => "literal" in part ? part.literal
      : encodeURIComponent(pathValue("arg" in part ? args[part.arg] : requireResource(part.resource).id))).join("/")
    const url = new URL(`${operation.origin}/${path}`)
    if (url.origin !== operation.origin || url.pathname !== `/${path}`) return deny()
    for (const [key, part] of Object.entries(operation.query)) {
      let value: string | number | boolean | undefined
      if (typeof part === "string") value = args[part]
      else if ("arg" in part) value = args[part.arg]
      else if ("literal" in part) value = part.literal
      else if ("resource" in part) value = requireResource(part.resource).id
      else {
        value = connection.identity?.[part.identity]
        if (value === undefined) throw new Rejected("RESOURCE_REQUIRED")
      }
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    return { origin: operation.origin, path: url.pathname + url.search,
      credential: { header: definition.auth.header, scheme: definition.auth.scheme, secret: connection.secret }, signal }
  }
  async function execute(call: unknown, audience: "setup" | "panel"): Promise<ConnectionResult> {
    let request: PluginHttpsInput
    try { request = build(call, audience) } catch (error) { return resultError(error, "INVALID_REQUEST") }
    let data: unknown
    try {
      data = await new Promise<unknown>((resolve, reject) => {
        const aborted = () => reject(new Rejected("CANCELED"))
        signal.addEventListener("abort", aborted, { once: true })
        Promise.resolve().then(() => { canceled(); return transport(request) }).then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", aborted))
      })
      canceled()
    } catch (error) { return resultError(error, "UPSTREAM_FAILED") }
    try {
      const value = parseJson(data, { maxBytes: CONTRACT_LIMITS.responseBytes, maxNodes: CONTRACT_LIMITS.responseNodes })
      if (containsSecret(value, connection.secret)) throw new Rejected("INVALID_RESPONSE")
      return { ok: true, data: value }
    } catch (error) { return resultError(error, "INVALID_RESPONSE") }
  }
  async function listOptionRecords(resourceId: string, includeParents: boolean): Promise<ConnectionResult<ResourceOption[]>> {
    if (!Object.hasOwn(definition.resources, resourceId) || !definition.resources[resourceId].options) return { ok: false, error: "INVALID_REQUEST" }
    const resource = definition.resources[resourceId]
    try { canceled(); for (const parent of connectionResourceDependencies(definition, resourceId)) requireResource(parent) }
    catch (error) { return resultError(error, "INVALID_REQUEST") }
    const sources = Array.isArray(resource.options) ? resource.options : [resource.options!]
    const selections: ResourceOption[] = [], ids = new Set<string>()
    for (const source of sources) {
      const result = await execute({ operation: source.operation, args: {} }, "setup")
      if (!result.ok) return result
      try {
        const outer = select(result.data, source.items)
        if (!Array.isArray(outer) || outer.length > CONNECTION_LIMITS.options) deny()
        for (const item of outer) {
          const children = source.nested === undefined ? [item] : select(item, source.nested)
          if (!Array.isArray(children) || children.length + selections.length > CONNECTION_LIMITS.options) deny()
          const parent = !includeParents || source.nested === undefined ? undefined : { id: responseId(select(item, source.id)), label: text(select(item, source.label), 128) }
          for (const child of children) {
            const id = responseId(select(child, source.id)), label = text(select(child, source.label), 128)
            if (ids.has(id)) deny()
            ids.add(id)
            selections.push({ selection: { id, label }, ...parent ? { parent } : {} })
          }
        }
      } catch { return { ok: false, error: "INVALID_RESPONSE" } }
    }
    return { ok: true, data: selections }
  }
  async function listOptions(resourceId: string): Promise<ConnectionResult<ResourceSelection[]>> {
    const result = await listOptionRecords(resourceId, false)
    return result.ok ? { ok: true, data: result.data.map(option => option.selection) } : result
  }
  function enteredId(resourceId: string, raw: string): string {
    const input = definition.resources[resourceId].input!
    const value = text(raw, 2048).trim()
    if (!value.includes("://")) return input.allowId ? pathValue(value) : deny()
    if (value.includes("\\") || /%(?:2e|2f|5c|25)/iu.test(value.split(/[?#]/u)[0])
      || value.split(/[?#]/u)[0].split("/").some((part) => part === "." || part === "..")) return deny()
    let url: URL
    try { url = new URL(value) } catch { return deny() }
    if (url.protocol !== "https:" || url.username || url.password || url.port) return deny()
    const parts = url.pathname.split("/").slice(1)
    const rules = input.urls?.filter((rule) => rule.origin === url.origin) ?? []
    const matches = new Set<string>()
    for (const rule of rules) {
      const positions = parts.flatMap((part, index) => part === rule.pathMarker ? [index] : [])
      if (positions.length === 1 && positions[0] + 1 < parts.length) matches.add(pathValue(parts[positions[0] + 1]))
    }
    if (matches.size !== 1) return deny()
    return [...matches][0]
  }
  async function resolveResourceInput(resourceId: string, input: string): Promise<ConnectionResult<ResolvedResourceInput>> {
    if (!Object.hasOwn(definition.resources, resourceId) || !definition.resources[resourceId].input) return { ok: false, error: "INVALID_REQUEST" }
    let id: string
    const mapping = definition.resources[resourceId].input!.validation
    try { canceled(); id = enteredId(resourceId, input) } catch (error) { return resultError(error, "INVALID_REQUEST") }
    const result = await execute({ operation: mapping.operation, args: { [mapping.argument]: id } }, "setup")
    if (!result.ok) return result
    try {
      if (mapping.id !== undefined && responseId(select(result.data, mapping.id)) !== id) deny()
      const parents: Record<string, string> = Object.create(null)
      for (const [parent, pointer] of Object.entries(mapping.parents ?? {})) parents[parent] = responseId(select(result.data, pointer))
      return { ok: true, data: { selection: { id, label: text(select(result.data, mapping.label), 128) }, parents } }
    } catch { return { ok: false, error: "INVALID_RESPONSE" } }
  }
  function updated(resourceId: string, selection: ResourceSelection | null): Record<string, ResourceSelection> {
    const next = structuredClone(connection.selected)
    if (selection && next[resourceId]?.id === selection.id) { next[resourceId] = selection; return next }
    const removed = new Set([resourceId])
    for (let index = 0; index < Object.keys(definition.resources).length; index++) {
      for (const name of Object.keys(definition.resources)) if (connectionResourceDependencies(definition, name).some((parent) => removed.has(parent))) removed.add(name)
    }
    for (const name of removed) delete next[name]
    if (selection) next[resourceId] = selection
    return next
  }
  return Object.freeze({
    request: (call: unknown): Promise<ConnectionResult> => execute(call, "panel"),
    async validate(): Promise<ConnectionResult<{ identity: Record<string, string> }>> {
      const result = await execute({ operation: definition.validationOperation, args: {} }, "setup")
      if (!result.ok) return result
      try {
        const identity: Record<string, string> = Object.create(null)
        for (const [key, pointer] of Object.entries(definition.identity ?? {})) identity[key] = responseId(select(result.data, pointer))
        return { ok: true, data: { identity } }
      } catch { return { ok: false, error: "INVALID_RESPONSE" } }
    },
    listOptions,
    listOptionsWithParents: (resourceId: string) => listOptionRecords(resourceId, true),
    resolveResourceInput,
    async selectResource(resourceId: string, input: string | null): Promise<ConnectionResult<Record<string, ResourceSelection>>> {
      if (!Object.hasOwn(definition.resources, resourceId)) return { ok: false, error: "INVALID_REQUEST" }
      try { canceled() } catch (error) { return resultError(error, "INVALID_REQUEST") }
      if (input === null) return { ok: true, data: updated(resourceId, null) }
      const resource = definition.resources[resourceId]
      try {
        text(input, 2048)
        for (const parent of connectionResourceDependencies(definition, resourceId)) requireResource(parent)
        if (resource.input && (resource.input.allowId || input.includes("://") || !resource.options)) {
          const result = await resolveResourceInput(resourceId, input)
          if (!result.ok) return result
          for (const [parent, id] of Object.entries(result.data.parents)) if (requireResource(parent).id !== id) return { ok: false, error: "INVALID_RESPONSE" }
          return { ok: true, data: updated(resourceId, result.data.selection) }
        }
        const result = await listOptions(resourceId)
        if (!result.ok) return result
        const choice = result.data.find((item) => item.id === input)
        return choice ? { ok: true, data: updated(resourceId, choice) } : { ok: false, error: "INVALID_REQUEST" }
      } catch (error) { return resultError(error, "INVALID_REQUEST") }
    },
    publicState: () => ({ label: connection.label, status: "configured" as const, selected: structuredClone(connection.selected) }),
  })
}
