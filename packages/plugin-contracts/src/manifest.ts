import { z } from "zod"
import { valid, validRange } from "semver"
import { CONTRACT_LIMITS } from "./json.js"
import { canonicalPath, identifier, label, parseSchema } from "./schema.js"
import { integrationPermissionSchema } from "./integrations.js"

export const PROTOCOL_MAJOR = 1 as const
export const PLUGIN_API_VERSION = "1.0.0"
export const RUNTIME = "browser-iife-v1" as const
export const versionSchema = z.string().max(128).refine((value) => valid(value) === value, "Expected strict SemVer")
const range = z.string().min(1).max(256).refine((value) => validRange(value) !== null, "Expected a SemVer range")
const capabilityMap = z.record(identifier, range).refine((value) => Object.keys(value).length <= 32, "Too many capabilities")
export const capabilitiesSchema = z.strictObject({ client: capabilityMap, host: capabilityMap })
const unique = (values: readonly string[]) => new Set(values).size === values.length
const names = z.array(identifier).max(32).refine(unique, "Duplicate identifier")
const localId = z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/u)
const size = z.string().regex(/^(?:[1-9][0-9]{0,3}px|(?:[1-9][0-9]?|100)%)$/u)

export const manifestSchema = z.strictObject({
  manifestVersion: z.literal(1),
  id: z.string().max(128).regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/u),
  publisher: localId,
  name: label,
  version: versionSchema,
  runtime: z.literal(RUNTIME),
  entry: canonicalPath.refine((value) => value.endsWith(".js"), "Entry must be JavaScript"),
  style: canonicalPath.refine((value) => value.endsWith(".css"), "Style must be CSS").optional(),
  engines: z.strictObject({ pluginApi: range, client: range, host: range }),
  protocol: z.literal(PROTOCOL_MAJOR).default(PROTOCOL_MAJOR),
  requires: capabilitiesSchema,
  optional: capabilitiesSchema.default({ client: {}, host: {} }),
  browser: z.array(z.enum(["message-channel", "blob-script", "web-crypto"])).max(3).refine(unique).default([]),
  contributes: z.strictObject({ panels: z.array(z.strictObject({
    id: localId, title: label,
    icon: canonicalPath.refine((value) => /\.(png|jpe?g|webp)$/u.test(value), "Expected a raster icon"),
    order: z.number().int().min(0).max(1000).optional(),
    defaultSize: size.optional(), minSize: size.optional(), maxSize: size.optional(),
    when: z.enum(["always", "project-selected"]).default("project-selected"),
  })).min(1).max(8) }),
  permissions: z.strictObject({
    context: z.array(z.literal("project.identity")).max(1).default([]),
    composer: z.array(z.literal("append")).max(1).default([]),
    navigation: z.array(z.enum(["external", "session"])).max(2).refine(unique).default([]),
    connections: z.array(z.strictObject({ id: identifier, definition: canonicalPath, operations: names.min(1) })).max(8).default([]),
    integrations: z.array(integrationPermissionSchema).max(2).default([]),
    storage: z.strictObject({ scope: z.enum(["project", "plugin"]), quotaKiB: z.number().int().min(1).max(1024) }).optional(),
  }),
  stateVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).superRefine((value, context) => {
  if (!value.id.startsWith(`${value.publisher}.`)) context.addIssue({ code: "custom", path: ["id"], message: "Plugin ID must belong to its publisher" })
  if (["cogpit.worktrees", "cogpit.project-files", "cogpit.browser", "cogpit.file-changes", "cogpit.session-info"].includes(value.id)) context.addIssue({ code: "custom", path: ["id"], message: "Reserved built-in ID" })
  for (const [key, entries] of [["panels", value.contributes.panels], ["connections", value.permissions.connections], ["integrations", value.permissions.integrations]] as const) {
    if (!unique(entries.map((entry) => entry.id))) context.addIssue({ code: "custom", path: [key], message: "Duplicate contribution ID" })
  }
  for (const side of ["client", "host"] as const) {
    for (const name of Object.keys(value.optional[side])) {
      if (Object.hasOwn(value.requires[side], name)) context.addIssue({ code: "custom", path: ["optional", side, name], message: "Capability is already required" })
    }
  }
})

export type PluginManifest = z.infer<typeof manifestSchema>
export type CapabilityRequirements = z.infer<typeof capabilitiesSchema>
export function parseManifest(value: unknown): PluginManifest {
  return parseSchema(manifestSchema, value, CONTRACT_LIMITS.manifestBytes)
}
