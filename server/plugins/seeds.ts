import { createHash } from "node:crypto"
import { valid } from "semver"
import { z } from "zod"
import { PACKAGE_LIMITS, inspectPackage, validatePackagePath, type InspectedPackage } from "./package"

export const appSeedProvenanceSchema = z.strictObject({
  publisher: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).refine(value => !value.startsWith("dev-")),
  pluginId: z.string().regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/).max(128), version: z.string().max(128).refine(value => valid(value) === value), targetPath: z.string().min(1).max(240),
  appVersion: z.string().max(128).refine(value => valid(value) === value),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).refine(value => value.pluginId.startsWith(`${value.publisher}.`), "Publisher does not own seed namespace")
export type AppSeedProvenance = z.infer<typeof appSeedProvenanceSchema>
export interface AppPluginSeed {
  id: string
  publisher: string
  targetPath: string
  appVersion: string
  payloadDigest: string
  payload: Buffer
}
export interface InspectedAppSeed { provenance: AppSeedProvenance; inspected: InspectedPackage }

/** Only application composition supplies this catalog; management requests select IDs. */
export function captureAppSeeds(seeds: readonly AppPluginSeed[] = []): ReadonlyMap<string, InspectedAppSeed> {
  if (!Array.isArray(seeds) || seeds.length > 256) throw new Error("Invalid app seed catalog")
  const result = new Map<string, InspectedAppSeed>()
  for (const seed of seeds) {
    if (!Buffer.isBuffer(seed.payload) || seed.payload.length > PACKAGE_LIMITS.upload) throw new Error("Invalid app seed payload")
    const payload = Buffer.from(seed.payload)
    const digest = createHash("sha256").update(payload).digest("hex")
    if (seed.payloadDigest !== digest) throw new Error("App seed digest differs from the release catalog")
    validatePackagePath(seed.targetPath)
    const inspected = inspectPackage(payload, seed.publisher)
    if (seed.id !== inspected.manifest.id || result.has(seed.id)) throw new Error("App seed identity is duplicate or mismatched")
    const provenance = appSeedProvenanceSchema.parse({ publisher: seed.publisher, pluginId: seed.id, version: inspected.manifest.version,
      targetPath: seed.targetPath, appVersion: seed.appVersion, digest })
    result.set(seed.id, { provenance, inspected })
  }
  return result
}
