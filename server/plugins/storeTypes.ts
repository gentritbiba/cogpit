import { z } from "zod"
import { appSeedProvenanceSchema, type AppPluginSeed } from "./seeds"
import { legacyHostSchema, type LegacyHostClassification } from "./legacyHost"
import { parseManifest, type ClientRuntimeDescriptor, type HostRuntimeDescriptor } from "@cogpit/plugin-contracts"
import type { InstalledPlugin, PluginInstallPreview, PluginScope } from "../../shared/contracts/plugins"
import { installedPluginSchema, pluginScopeSchema, clientRuntimeSchema, compatibilityResultSchema, pluginPreviewSchema } from "../../shared/contracts/pluginManagement"

export type PluginAuthorize = () => void | Promise<void>
export interface PluginMutationOptions { authorize: PluginAuthorize; expectedRevision: number }
export interface PluginDataDeletion { id: string; principalId: string; publisher: string; pluginId: string }
export interface PluginStageOptions { owner: string; client: ClientRuntimeDescriptor; scope: PluginScope; authorize: PluginAuthorize; idempotencyKey?: string }
export interface PluginStoreOptions {
  host: HostRuntimeDescriptor
  officialRoots?: ReadonlyMap<string, Buffer>
  appSeeds?: readonly AppPluginSeed[]
  legacyHost?: LegacyHostClassification
  beforeChange?: (pluginId: string, reason: string) => void | Promise<void>
  afterMutation?: () => void
  onCompromised?: (reason: string) => void
  crashHook?: (step: string) => void | Promise<void>
}
export class PluginStoreError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "PluginStoreError" }
}

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const publisher = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
const pluginId = z.string().regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/).max(128)
const manifest = z.unknown().transform(value => parseManifest(value))
export const scopeSchema = pluginScopeSchema
const pluginSchema = installedPluginSchema
export const registrySchema = z.strictObject({
  formatVersion: z.literal(1), minWriterVersion: z.literal(1), revision: integer,
  plugins: z.record(pluginId, pluginSchema).refine(value => Object.keys(value).length <= 256),
  dataSchemas: z.record(pluginId, z.array(integer.min(1)).min(1).max(128)),
  identities: z.record(z.string().min(1).max(256), digest),
  quarantined: z.record(digest, z.strictObject({ reason: z.string().max(500), detectedAt: integer })).optional(),
  pendingDataDeletions: z.array(z.strictObject({ id: z.string().uuid(), principalId: z.string().min(1).max(256), publisher, pluginId })).max(1024).optional(),
  seedMigration: z.strictObject({ classification: legacyHostSchema.optional(), decisions: z.record(pluginId, z.enum(["imported", "preserved", "uninstalled", "fresh"])) }).optional(),
})
export type PluginRegistry = z.infer<typeof registrySchema>
const verifiedTargetSchema = z.strictObject({ path: z.string().max(512), length: integer, hashes: z.record(z.string().max(32), z.string().max(256)), custom: z.record(z.string(), z.unknown()) })
export const checkpointSchema = z.strictObject({ verifiedAt: integer, metadata: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*\.json$/), z.string().max(400000)), verifiedTargets: z.record(z.string().max(512), verifiedTargetSchema), revokedTargets: z.array(z.string().max(512)).max(4096) })
const publisherSchema = z.strictObject({ kind: z.enum(["official", "development"]), label: z.string().min(1).max(100), pinnedRoot: z.string().max(400000), checkpoint: checkpointSchema.optional() })
export const trustSchema = z.strictObject({ formatVersion: z.literal(1), minWriterVersion: z.literal(1), appSeeds: z.record(digest, appSeedProvenanceSchema).optional(), publishers: z.record(publisher, publisherSchema).refine(value => Object.keys(value).length <= 256 && Object.entries(value).every(([id, record]) => (record.kind === "development") === id.startsWith("dev-"))) })
export type PluginTrustDocument = z.infer<typeof trustSchema>
const runtimeSchema = clientRuntimeSchema
const compatibilitySchema = compatibilityResultSchema
export const journalSchema = z.strictObject({
  formatVersion: z.literal(1), minWriterVersion: z.literal(1), id: z.string().uuid(), ownerHash: digest,
  status: z.enum(["prepared", "trial", "committing", "committed", "cancelled"]),
  createdAt: integer, deadline: integer.optional(), registryRevision: integer,
  manifest, digest, targetPath: z.string().min(1).max(512), publisherKind: z.enum(["official", "development"]),
  oldVersion: z.string().nullable(), scope: scopeSchema, client: runtimeSchema, compatibility: compatibilitySchema,
  connectionDefinitions: pluginPreviewSchema.shape.connectionDefinitions,
  previousManifest: manifest.optional(), previousConnectionDefinitions: pluginPreviewSchema.shape.connectionDefinitions.optional(),
  idempotencyHash: digest.optional(), uploadHash: digest, operation: z.enum(["install", "rollback"]),
  appSeed: appSeedProvenanceSchema.optional(), automaticSeedMigration: z.boolean().optional(),
  nextRegistry: registrySchema.optional(), reason: z.string().max(1000).optional(),
})
export type PluginJournal = z.infer<typeof journalSchema>
export type StoredCheckpoint = z.infer<typeof checkpointSchema>
export const initialRegistry = (): PluginRegistry => ({ formatVersion: 1, minWriterVersion: 1, revision: 0, plugins: {}, dataSchemas: {}, identities: {} })
export const initialTrust = (): PluginTrustDocument => ({ formatVersion: 1, minWriterVersion: 1, publishers: {} })
export function previewOf(journal: PluginJournal): PluginInstallPreview {
  return structuredClone({ transactionId: journal.id, manifest: journal.manifest, digest: journal.digest, compatibility: journal.compatibility, oldVersion: journal.oldVersion, registryRevision: journal.registryRevision, publisherKind: journal.publisherKind, scope: journal.scope, connectionDefinitions: journal.connectionDefinitions, operation: journal.operation === "rollback" ? "rollback" : journal.oldVersion === null ? "install" : "update", previousManifest: journal.previousManifest, previousConnectionDefinitions: journal.previousConnectionDefinitions })
}
export function installedOf(plugin: PluginRegistry["plugins"][string]): InstalledPlugin { return structuredClone(plugin) }
