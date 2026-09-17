import { z } from "zod"
import { parseConnectionDefinition } from "@cogpit/plugin-contracts"

const identifier = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/).max(64)
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const pluginConnectionTargetSchema = z.strictObject({
  pluginId: z.string().regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/).max(128),
  projectId: z.string().regex(/^p_[a-f0-9]{40}$/).nullable(),
})
export const pluginConnectionRevisionSchema = pluginConnectionTargetSchema.extend({ expectedRevision: revision })
export const pluginConnectionIdentitySchema = pluginConnectionTargetSchema.extend({ connectionId: identifier })
export const pluginConnectionMutationSchema = pluginConnectionIdentitySchema.extend({ expectedRevision: revision })
export const pluginResourceSelectionSchema = z.strictObject({ id: z.string().min(1).max(1024), label: z.string().min(1).max(256) })
export const pluginResourceOptionsSchema = z.array(pluginResourceSelectionSchema).max(1000)
export const pluginConnectionSnapshotSchema = z.strictObject({
  revision,
  connections: z.array(z.strictObject({
    id: identifier, label: z.string().min(1).max(128),
    status: z.enum(["disconnected", "connected", "environment"]), readOnly: z.boolean(),
    legacyImportAvailable: z.boolean().optional(),
    selected: z.record(identifier, pluginResourceSelectionSchema).refine((value) => Object.keys(value).length <= 8),
    definition: z.unknown().transform(parseConnectionDefinition),
  })).max(8),
})
export type PluginConnectionTarget = z.infer<typeof pluginConnectionTargetSchema>
export type PluginConnectionSnapshot = z.infer<typeof pluginConnectionSnapshotSchema>
export type PluginConnectionSummary = PluginConnectionSnapshot["connections"][number]
export type PluginResourceSelection = z.infer<typeof pluginResourceSelectionSchema>
