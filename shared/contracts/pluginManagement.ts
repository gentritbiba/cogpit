import { z } from "zod"
import { parseClientRuntimeDescriptor, parseHostRuntimeDescriptor, parseManifest, parseConnectionDefinition } from "@cogpit/plugin-contracts"

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const manifest = z.unknown().transform(parseManifest)
export const pluginScopeSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("all") }),
  z.strictObject({ type: z.literal("projects"), projectIds: z.array(z.string().min(1).max(512)).max(128).refine((ids) => new Set(ids).size === ids.length) }),
])
export const installedPluginVersionSchema = z.strictObject({ digest, manifest, targetPath: z.string().min(1).max(512), installedAt: integer, unavailableReason: z.string().max(1000).optional() })
export const installedPluginSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/).max(128),
  selectedDigest: digest, manifest, enabled: z.boolean(), scope: pluginScopeSchema,
  pinned: z.boolean(), versions: z.array(installedPluginVersionSchema).min(1).max(64), lastError: z.string().max(1000).optional(),
})
const publisherSummary = z.strictObject({ id: z.string().max(128), label: z.string().max(128), kind: z.enum(["official", "development"]), fingerprint: z.string().max(128), verifiedAt: integer.optional() })
export const pluginSnapshotSchema = z.strictObject({
  available: z.boolean(), error: z.string().max(2000).optional(), revision: integer,
  plugins: z.array(installedPluginSchema).max(256), publishers: z.array(publisherSummary).max(256),
  legacyPluginIds: z.array(z.enum(["github", "clickup", "vercel-deployments"])).max(3).optional(),
  availableSeeds: z.array(z.strictObject({ manifest, digest })).max(256).optional(),
  recoveryCode: z.enum(["STORE_LOCKED", "STORE_VERSION", "STORE_CORRUPT", "STORE_UNAVAILABLE"]).optional(),
})
const optionalIssue = z.strictObject({ side: z.enum(["client", "host"]), name: z.string().max(128), required: z.string().max(256), actual: z.string().max(512).nullable() })
export const compatibilityResultSchema = z.strictObject({
  compatible: z.boolean(), apiVersion: z.string().max(128).nullable(),
  issues: z.array(z.strictObject({
    side: z.enum(["client", "host", "package"]),
    code: z.enum(["APP_VERSION", "API_VERSION", "MANIFEST_VERSION", "PROTOCOL_VERSION", "RUNTIME", "CAPABILITY", "BROWSER", "PRERELEASE", "REVOKED"]),
    name: z.string().max(128), required: z.string().max(256), actual: z.string().max(512).nullable(),
  })).max(128),
  unavailableOptional: z.array(optionalIssue).max(128),
})
export const clientRuntimeSchema = z.unknown().transform(parseClientRuntimeDescriptor)
export const pluginPreviewSchema = z.strictObject({
  transactionId: z.string().uuid(), manifest, digest, compatibility: compatibilityResultSchema,
  connectionDefinitions: z.array(z.unknown().transform(parseConnectionDefinition)).max(8),
  oldVersion: z.string().max(128).nullable(), registryRevision: integer,
  publisherKind: z.enum(["official", "development"]), scope: pluginScopeSchema,
  operation: z.enum(["install", "update", "rollback"]).optional(),
  previousManifest: manifest.optional(),
  previousConnectionDefinitions: z.array(z.unknown().transform(parseConnectionDefinition)).max(8).optional(),
  incompatibleClients: z.array(z.string().max(256)).max(256).optional(),
})
export const pluginProjectSchema = z.strictObject({ id: z.string().regex(/^p_[a-f0-9]{40}$/), name: z.string().max(512), paths: z.array(z.string().max(8192)).max(256) })
export type PluginProjectSummary = z.infer<typeof pluginProjectSchema>
export const pluginHostStatusSchema = z.strictObject({
  runtime: z.unknown().transform(parseHostRuntimeDescriptor),
  host: z.strictObject({ name: z.string().max(256), instanceId: z.string().max(128) }),
  store: pluginSnapshotSchema,
  projects: z.array(pluginProjectSchema).max(1024),
  safeMode: z.boolean(),
  connectionRevision: integer.optional(),
})
export type PluginHostStatus = z.infer<typeof pluginHostStatusSchema>
