import { z } from "zod"
import { CONTRACT_LIMITS } from "./json.js"
import { identifier, label, parseSchema } from "./schema.js"

const origin = z.string().max(256).refine((value) => {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && url.origin === value && !url.username && !url.password && !url.port
      && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/u.test(url.hostname)
      && !/\.(?:localhost|local|internal)$/u.test(url.hostname)
  } catch { return false }
}, "Expected an exact public HTTPS origin")
const pointer = z.string().max(256).refine((value) => (!value || value.startsWith("/")) && !/~(?![01])/u.test(value)
  && value.split("/").length <= 9 && !value.split("/").some((key) => ["__proto__", "prototype", "constructor"].includes(key)), "Invalid bounded JSON pointer")
const literalSegment = z.string().min(1).max(1024).regex(/^[a-zA-Z0-9._~-]+$/u).refine((value) => value !== "." && value !== "..")
const argument = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("string"), required: z.boolean().optional(), maxLength: z.number().int().min(1).max(1024), enum: z.array(label).min(1).max(32).optional() }),
  z.strictObject({ type: z.literal("integer"), required: z.boolean().optional(), min: z.number().int().min(Number.MIN_SAFE_INTEGER), max: z.number().int().max(Number.MAX_SAFE_INTEGER) }),
  z.strictObject({ type: z.literal("boolean"), required: z.boolean().optional() }),
])
const segment = z.union([
  z.strictObject({ literal: literalSegment }), z.strictObject({ resource: identifier }), z.strictObject({ arg: identifier }),
])
const queryValue = z.union([
  identifier,
  z.strictObject({ literal: z.union([z.string().max(1024), z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), z.boolean()]) }),
  z.strictObject({ arg: identifier }), z.strictObject({ resource: identifier }), z.strictObject({ identity: identifier }),
])
const operation = z.strictObject({
  audience: z.enum(["setup", "panel"]), origin, method: z.literal("GET"),
  path: z.array(segment).min(1).max(16),
  args: z.record(identifier, argument).refine((value) => Object.keys(value).length <= 16),
  query: z.record(z.string().max(68).regex(/^[a-zA-Z][a-zA-Z0-9_.-]*(?:\[\])?$/u)
    .refine((value) => !["constructor", "prototype", "__proto__"].includes(value.replace(/\[\]$/u, ""))), queryValue)
    .refine((value) => Object.keys(value).length <= 16),
})
const optionSource = z.strictObject({ operation: identifier, items: pointer, nested: pointer.optional(), id: pointer, label: pointer })
const resource = z.strictObject({
  label, scope: z.enum(["connection", "project"]).optional(),
  dependsOn: z.array(identifier).max(7).refine((items) => new Set(items).size === items.length).optional(),
  options: z.union([optionSource, z.array(optionSource).min(1).max(4)]).optional(),
  input: z.strictObject({
    allowId: z.boolean(), urls: z.array(z.strictObject({ origin, pathMarker: literalSegment })).min(1).max(8).optional(),
    validation: z.strictObject({ operation: identifier, argument: identifier, id: pointer.optional(), label: pointer,
      parents: z.record(identifier, pointer).refine((value) => Object.keys(value).length <= 7).optional() }),
  }).optional(),
}).refine((value) => !!value.options || !!value.input, "Expected listed or validated entered resources")

const definitionShape = z.strictObject({
  version: z.literal(1), id: identifier, label,
  secret: z.strictObject({ id: identifier, label }),
  auth: z.strictObject({
    header: z.string().max(64).regex(/^(?:Authorization|X-[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*)$/iu)
      .refine((value) => !/^x-(?:forwarded|http-method|original|rewrite)(?:-|$)/iu.test(value), "Unsafe credential header"),
    scheme: z.enum(["raw", "bearer"]),
  }),
  validationOperation: identifier,
  identity: z.record(identifier, pointer).refine((value) => Object.keys(value).length <= 8).optional(),
  resources: z.record(identifier, resource).refine((value) => Object.keys(value).length <= 8),
  operations: z.record(identifier, operation).refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 32),
})
export type ConnectionDefinition = z.infer<typeof definitionShape>
export type ConnectionOperation = ConnectionDefinition["operations"][string]
export type ConnectionResource = ConnectionDefinition["resources"][string]
export type ConnectionQueryValue = ConnectionOperation["query"][string]

function operationResources(op: ConnectionOperation | undefined): string[] {
  if (!op) return []
  return [...op.path.flatMap((part) => "resource" in part ? [part.resource] : []),
    ...Object.values(op.query).flatMap((part) => typeof part === "object" && "resource" in part ? [part.resource] : [])]
}
export function connectionResourceDependencies(definition: ConnectionDefinition, resourceId: string): string[] {
  const value = definition.resources[resourceId]
  if (!value) return []
  const sources = value.options ? Array.isArray(value.options) ? value.options : [value.options] : []
  return [...new Set([...(value.dependsOn ?? []), ...sources.flatMap((source) => operationResources(definition.operations[source.operation])),
    ...operationResources(value.input ? definition.operations[value.input.validation.operation] : undefined)])]
}

export const connectionDefinitionSchema = definitionShape.superRefine((definition, context) => {
  const issue = (path: string[], message: string) => context.addIssue({ code: "custom", path, message })
  const setup = (name: string) => definition.operations[name]?.audience === "setup"
  const requireNoArguments = (op: ConnectionOperation | undefined, except?: string) => op && Object.entries(op.args).every(([key, spec]) => !spec.required || key === except)
  const validation = definition.operations[definition.validationOperation]
  if (!setup(definition.validationOperation) || !requireNoArguments(validation) || operationResources(validation).length
    || Object.values(validation?.query ?? {}).some((part) => typeof part === "object" && "identity" in part)) {
    issue(["validationOperation"], "Expected an independent setup operation without required arguments")
  }
  for (const [name, value] of Object.entries(definition.resources)) {
    const dependencies = connectionResourceDependencies(definition, name)
    for (const dependency of dependencies) {
      if (dependency === name || !Object.hasOwn(definition.resources, dependency)) issue(["resources", name, "dependsOn"], "Unknown or self-dependent resource")
      if ((value.scope ?? "connection") === "connection" && definition.resources[dependency]?.scope === "project") {
        issue(["resources", name, "scope"], "Connection resource cannot depend on a project resource")
      }
    }
    const sources = value.options ? Array.isArray(value.options) ? value.options : [value.options] : []
    for (const source of sources) {
      const op = definition.operations[source.operation]
      if (!setup(source.operation) || !requireNoArguments(op)) issue(["resources", name, "options"], "Expected a setup operation without required arguments")
      if (dependencies.some((parent) => !operationResources(op).includes(parent))) issue(["resources", name, "options"], "Every options source must bind all parent resources")
    }
    if (value.input) {
      const input = value.input, mapping = input.validation, op = definition.operations[mapping.operation], spec = op?.args[mapping.argument]
      if (!input.allowId && !input.urls) issue(["resources", name, "input"], "Expected an accepted input format")
      if (!setup(mapping.operation) || !requireNoArguments(op, mapping.argument) || spec?.type !== "string" || !spec.required
        || op.path.filter((part) => "arg" in part && part.arg === mapping.argument).length !== 1) {
        issue(["resources", name, "input", "validation"], "Validation must request the candidate as one required path argument")
      }
      if (dependencies.some((parent) => !Object.hasOwn(mapping.parents ?? {}, parent))
        || Object.keys(mapping.parents ?? {}).some((parent) => !dependencies.includes(parent))) {
        issue(["resources", name, "input", "validation", "parents"], "Validation must prove each selected parent")
      }
    }
  }
  const visiting = new Set<string>(), visited = new Set<string>()
  const visit = (name: string): void => {
    if (visiting.has(name)) { issue(["resources", name, "dependsOn"], "Resource dependency cycle"); return }
    if (visited.has(name)) return
    visiting.add(name)
    for (const parent of connectionResourceDependencies(definition, name)) if (Object.hasOwn(definition.resources, parent)) visit(parent)
    visiting.delete(name)
    visited.add(name)
  }
  for (const name of Object.keys(definition.resources)) visit(name)
  for (const [name, op] of Object.entries(definition.operations)) {
    const usedArgs = new Set<string>()
    for (const [key, spec] of Object.entries(op.args)) {
      if (Object.hasOwn(definition.resources, key) || Object.hasOwn(definition.identity ?? {}, key)) issue(["operations", name, "args", key], "Argument shadows a host-owned binding")
      if (spec.type === "integer" && spec.min > spec.max) issue(["operations", name, "args", key], "Inverted integer bounds")
      if (spec.type === "string" && spec.enum?.some((value) => new TextEncoder().encode(value).byteLength > spec.maxLength)) issue(["operations", name, "args", key], "Enum exceeds string limit")
    }
    for (const part of op.path) {
      if ("resource" in part && !Object.hasOwn(definition.resources, part.resource)) issue(["operations", name, "path"], "Unknown selected resource")
      if ("arg" in part) {
        const spec = op.args[part.arg]
        if (spec?.type !== "string" || spec.required !== true) issue(["operations", name, "path"], "Path argument must be a required string")
        usedArgs.add(part.arg)
      }
    }
    for (const part of Object.values(op.query)) {
      const key = typeof part === "string" ? part : "arg" in part ? part.arg : undefined
      if (key !== undefined) {
        if (!Object.hasOwn(op.args, key)) issue(["operations", name, "query"], "Unknown query argument")
        usedArgs.add(key)
      } else if (typeof part === "object" && "resource" in part && !Object.hasOwn(definition.resources, part.resource)) issue(["operations", name, "query"], "Unknown selected resource")
      else if (typeof part === "object" && "identity" in part && !Object.hasOwn(definition.identity ?? {}, part.identity)) issue(["operations", name, "query"], "Unknown validated identity")
    }
    if (Object.keys(op.args).some((key) => !usedArgs.has(key))) issue(["operations", name, "args"], "Unused argument")
  }
})

export function parseConnectionDefinition(value: unknown): ConnectionDefinition {
  return parseSchema(connectionDefinitionSchema, value, CONTRACT_LIMITS.definitionBytes)
}
