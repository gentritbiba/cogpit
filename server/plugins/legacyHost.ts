import { join, resolve } from "node:path"
import { z } from "zod"
import { PERSISTED_AGENT_HOME_FIELD } from "../../shared/session/agent-descriptors"
import { acquirePluginStoreLock } from "./lock"
import { documentBytes, durableWrite, ensureDirectory, exists, regularFile } from "./durable"
import { parseJsonText } from "./json"

export const legacyHostSchema = z.strictObject({
  formatVersion: z.literal(1), minWriterVersion: z.literal(1),
  classification: z.enum(["fresh", "legacy", "indeterminate"]),
  capturedAt: z.number().int().nonnegative(),
  evidence: z.enum(["no-config", "config.local.json", "invalid-config", "classification-unavailable", "runtime-config"]),
})
export type LegacyHostClassification = z.infer<typeof legacyHostSchema>

const ownedConfigFields = {
  [PERSISTED_AGENT_HOME_FIELD]: z.string().trim().min(1).max(8192).optional(),
  edition: z.literal("team").optional(), networkAccess: z.boolean().optional(),
  terminalApp: z.string().trim().min(1).max(512).optional(), editorApp: z.string().trim().min(1).max(512).optional(),
  useBuiltInEditor: z.boolean().optional(),
}
const ownedConfigSchema = z.object(ownedConfigFields).passthrough().refine(value => Object.keys(ownedConfigFields).some(key => Object.hasOwn(value, key)))

/** Call before config loading, bootstrap defaults, or any other first-run writes. */
export async function captureLegacyPluginHost(dataRoot: string): Promise<LegacyHostClassification> {
  try { return await captureLocked(dataRoot) }
  catch { return { formatVersion: 1, minWriterVersion: 1, classification: "indeterminate", capturedAt: Date.now(), evidence: "classification-unavailable" } }
}
async function captureLocked(dataRoot: string): Promise<LegacyHostClassification> {
  const directory = join(resolve(dataRoot), "plugin-host-classification")
  await ensureDirectory(directory)
  const lock = await acquirePluginStoreLock(directory, () => {})
  try {
    const path = join(directory, "host.json")
    if (await exists(path)) return legacyHostSchema.parse(parseJsonText(await regularFile(path), 4096))
    let classification: LegacyHostClassification["classification"] = "fresh"
    let evidence: LegacyHostClassification["evidence"] = "no-config"
    const configPath = join(resolve(dataRoot), "config.local.json")
    if (await exists(configPath)) {
      try {
        const value = parseJsonText(await regularFile(configPath), 65536)
        if (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "runtimePluginsVersion")) {
          if ((value as Record<string, unknown>).runtimePluginsVersion !== 1) throw new Error("Unknown runtime plugin config marker")
          classification = "fresh"; evidence = "runtime-config"
        } else {
          ownedConfigSchema.parse(value)
          classification = "legacy"; evidence = "config.local.json"
        }
      } catch { classification = "indeterminate"; evidence = "invalid-config" }
    }
    const captured = legacyHostSchema.parse({ formatVersion: 1, minWriterVersion: 1, classification, capturedAt: Date.now(), evidence })
    await durableWrite(path, documentBytes(captured), { label: "host-classification", guard: lock.assertOwned })
    return captured
  } finally { await lock.release() }
}

export const LEGACY_PLUGIN_ALIASES: Readonly<Record<string, string>> = Object.freeze({ github: "cogpit.github", clickup: "cogpit.clickup", "vercel-deployments": "cogpit.vercel" })
export function remainingLegacyPluginIds(classification?: LegacyHostClassification, decisions: Readonly<Record<string, string>> = {}): string[] {
  if (classification && classification.classification !== "legacy") return []
  return Object.entries(LEGACY_PLUGIN_ALIASES).filter(([, id]) => !decisions[id]).map(([legacy]) => legacy)
}
