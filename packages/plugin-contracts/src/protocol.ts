import { z } from "zod"
import { CONTRACT_LIMITS, type JsonValue, parseJson } from "./json.js"
import { boundedText, identifier, label, parseSchema } from "./schema.js"
import { PROTOCOL_MAJOR } from "./manifest.js"
import { integrationRequestSchema, integrationResultSchema, type PluginIntegrationRequest, type PluginIntegrationResult } from "./integrations.js"

const json = z.custom<JsonValue>(() => true)
const empty = z.strictObject({})
const project = z.strictObject({ id: identifier, name: label }).nullable()
const theme = z.strictObject({
  mode: z.enum(["light", "dark"]),
  tokens: z.record(z.string().regex(/^--[a-z][a-z0-9-]{0,63}$/u), boundedText(256)).refine((value) => Object.keys(value).length <= 64),
})
export const pluginContextSchema = z.strictObject({
  project, theme, locale: z.string().min(1).max(64), reducedMotion: z.boolean(), visible: z.boolean(),
})
export type PluginContext = z.infer<typeof pluginContextSchema>
export function parsePluginContext(value: unknown): PluginContext { return parseSchema(pluginContextSchema, value, CONTRACT_LIMITS.responseBytes) }

export const ERROR_CODES = [
  "INVALID_REQUEST", "INVALID_RESPONSE", "INCOMPATIBLE_HOST", "INCOMPATIBLE_CLIENT", "PERMISSION_REQUIRED",
  "CONNECTION_REQUIRED", "RESOURCE_REQUIRED", "STALE_ACTIVATION", "RATE_LIMITED", "PLUGIN_DISABLED",
  "CAPABILITY_UNAVAILABLE", "UPSTREAM_FAILED", "CANCELED", "TIMEOUT", "DISPOSED",
] as const
export const pluginErrorSchema = z.strictObject({ code: z.enum(ERROR_CODES), message: boundedText(512) })
export type PluginError = z.infer<typeof pluginErrorSchema>
const requestId = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/u)
const httpsUrl = z.string().min(1).max(2048).refine((value) => {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password } catch { return false }
}, "Expected an HTTPS URL without credentials")
const storageKey = identifier
const paramsSchemas = {
  "lifecycle.ready": empty,
  "connections.request": z.strictObject({ handle: identifier, operationId: identifier, args: z.record(identifier, z.union([z.string(), z.number().finite(), z.boolean()])) }),
  "connections.status": z.strictObject({ handle: identifier }),
  "integrations.request": integrationRequestSchema,
  "storage.get": z.strictObject({ key: storageKey }),
  "storage.set": z.strictObject({ key: storageKey, value: json }),
  "storage.delete": z.strictObject({ key: storageKey }),
  "composer.append": z.strictObject({ text: boundedText(CONTRACT_LIMITS.composerBytes) }),
  "navigation.openExternal": z.strictObject({ url: httpsUrl }),
  "navigation.openSession": z.strictObject({ handle: identifier }),
} as const

const connectionStatusSchema = z.strictObject({
  configured: z.boolean(),
  readOnly: z.boolean(),
  selected: z.record(identifier, z.strictObject({ id: boundedText(1024), label: boundedText(256) }))
    .refine((value) => Object.keys(value).length <= 8),
})
export type PluginConnectionStatus = z.infer<typeof connectionStatusSchema>

export interface MethodMap {
  "lifecycle.ready": { params: Record<string, never>; result: null }
  "connections.request": { params: { handle: string; operationId: string; args: Record<string, string | number | boolean> }; result: JsonValue }
  "connections.status": { params: { handle: string }; result: PluginConnectionStatus }
  "integrations.request": { params: PluginIntegrationRequest; result: PluginIntegrationResult }
  "storage.get": { params: { key: string }; result: JsonValue }
  "storage.set": { params: { key: string; value: JsonValue }; result: null }
  "storage.delete": { params: { key: string }; result: null }
  "composer.append": { params: { text: string }; result: null }
  "navigation.openExternal": { params: { url: string }; result: null }
  "navigation.openSession": { params: { handle: string }; result: null }
}
export type PluginMethod = keyof MethodMap
export type PluginRequest = { [M in PluginMethod]: { protocol: 1; type: "request"; id: string; method: M; params: MethodMap[M]["params"] } }[PluginMethod]
export type PluginEvent =
  | { protocol: 1; type: "event"; event: "context"; value: PluginContext }
  | { protocol: 1; type: "event"; event: "theme"; value: PluginContext["theme"] }
  | { protocol: 1; type: "event"; event: "visibility"; value: boolean }
  | { protocol: 1; type: "event"; event: "dispose"; value: null }
export type FrameMessage = PluginRequest | PluginEvent
  | { protocol: 1; type: "result"; id: string; value: JsonValue }
  | { protocol: 1; type: "error"; id: string; error: PluginError }
  | { protocol: 1; type: "cancel"; id: string }

const eventSchema = z.discriminatedUnion("event", [
  z.strictObject({ protocol: z.literal(PROTOCOL_MAJOR), type: z.literal("event"), event: z.literal("context"), value: pluginContextSchema }),
  z.strictObject({ protocol: z.literal(PROTOCOL_MAJOR), type: z.literal("event"), event: z.literal("theme"), value: theme }),
  z.strictObject({ protocol: z.literal(PROTOCOL_MAJOR), type: z.literal("event"), event: z.literal("visibility"), value: z.boolean() }),
  z.strictObject({ protocol: z.literal(PROTOCOL_MAJOR), type: z.literal("event"), event: z.literal("dispose"), value: z.null() }),
])
const envelopeSchema = z.union([
  z.strictObject({ protocol: z.literal(PROTOCOL_MAJOR), type: z.literal("request"), id: requestId, method: z.enum(Object.keys(paramsSchemas) as [PluginMethod, ...PluginMethod[]]), params: json }),
  z.strictObject({ protocol: z.literal(PROTOCOL_MAJOR), type: z.literal("result"), id: requestId, value: json }),
  z.strictObject({ protocol: z.literal(PROTOCOL_MAJOR), type: z.literal("error"), id: requestId, error: pluginErrorSchema }),
  z.strictObject({ protocol: z.literal(PROTOCOL_MAJOR), type: z.literal("cancel"), id: requestId }), eventSchema,
])

export function parseFrameMessage(value: unknown): FrameMessage {
  const resultEnvelope = value !== null && typeof value === "object" && Object.getOwnPropertyDescriptor(value, "type")?.value === "result"
  const message = parseSchema(envelopeSchema, value, resultEnvelope ? CONTRACT_LIMITS.resultMessageBytes : CONTRACT_LIMITS.messageBytes,
    resultEnvelope ? CONTRACT_LIMITS.responseNodes + 16 : CONTRACT_LIMITS.nodes)
  if (message.type === "request") {
    const maxBytes = message.method === "composer.append" ? CONTRACT_LIMITS.composerBytes + 64
      : message.method === "storage.set" ? CONTRACT_LIMITS.storageValueBytes : CONTRACT_LIMITS.argumentBytes
    const params = parseSchema(paramsSchemas[message.method] as z.ZodType, message.params, maxBytes)
    return { ...message, params } as PluginRequest
  }
  if (message.type === "result") return { ...message, value: parseJson(message.value, { maxBytes: CONTRACT_LIMITS.responseBytes, maxNodes: CONTRACT_LIMITS.responseNodes }) }
  return message
}

export function parseMethodResult<M extends PluginMethod>(method: M, value: unknown): MethodMap[M]["result"] {
  const schema = method === "integrations.request" ? integrationResultSchema : method === "connections.status" ? connectionStatusSchema
    : method === "connections.request" || method === "storage.get" ? json : z.null()
  return parseSchema(schema, value, CONTRACT_LIMITS.responseBytes, CONTRACT_LIMITS.responseNodes) as MethodMap[M]["result"]
}
