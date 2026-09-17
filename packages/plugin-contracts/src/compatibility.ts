import { satisfies, valid, validRange, prerelease, rcompare, major, Range, minVersion, compare } from "semver"
import type { PluginManifest } from "./manifest.js"
import { z } from "zod"
import { identifier, parseSchema } from "./schema.js"
import { versionSchema } from "./manifest.js"

export interface RuntimeDescriptor {
  appVersion: string
  apiVersions: readonly string[]
  manifestVersions: readonly number[]
  protocolVersions: readonly number[]
  runtimes: readonly string[]
  capabilities: Readonly<Record<string, string>>
}
export interface ClientRuntimeDescriptor extends RuntimeDescriptor { browser: readonly string[] }
export interface HostRuntimeDescriptor extends RuntimeDescriptor { platform: string; registryRevision: number }
const descriptorFields = {
  appVersion: z.string().min(1).max(128),
  apiVersions: z.array(versionSchema).max(16),
  manifestVersions: z.array(z.number().int().min(1).max(1024)).max(16),
  protocolVersions: z.array(z.number().int().min(1).max(1024)).max(16),
  runtimes: z.array(z.string().min(1).max(64)).max(16),
  capabilities: z.record(identifier, versionSchema).refine((value) => Object.keys(value).length <= 64),
}
const clientDescriptorSchema = z.strictObject({ ...descriptorFields, browser: z.array(z.string().min(1).max(64)).max(16) })
const hostDescriptorSchema = z.strictObject({ ...descriptorFields, platform: z.string().min(1).max(32), registryRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) })
export function parseClientRuntimeDescriptor(value: unknown): ClientRuntimeDescriptor { return parseSchema(clientDescriptorSchema, value, 16 * 1024) }
export function parseHostRuntimeDescriptor(value: unknown): HostRuntimeDescriptor { return parseSchema(hostDescriptorSchema, value, 16 * 1024) }
export interface CompatibilityIssue {
  side: "client" | "host" | "package"
  code: "APP_VERSION" | "API_VERSION" | "MANIFEST_VERSION" | "PROTOCOL_VERSION" | "RUNTIME" | "CAPABILITY" | "BROWSER" | "PRERELEASE" | "REVOKED"
  name: string
  required: string
  actual: string | null
}
export interface CompatibilityResult {
  compatible: boolean
  apiVersion: string | null
  issues: CompatibilityIssue[]
  unavailableOptional: { side: "client" | "host"; name: string; required: string; actual: string | null }[]
}

export function evaluateCompatibility(
  manifest: PluginManifest, client: ClientRuntimeDescriptor, host: HostRuntimeDescriptor,
  options: { allowPrerelease?: boolean; revoked?: boolean } = {},
): CompatibilityResult {
  const issues: CompatibilityIssue[] = []
  const unavailableOptional: CompatibilityResult["unavailableOptional"] = []
  const matches = (version: string, range: string) => !!valid(version) && !!validRange(range)
    && satisfies(version, range, { includePrerelease: options.allowPrerelease === true })
  const add = (side: CompatibilityIssue["side"], code: CompatibilityIssue["code"], name: string, required: string, actual: string | null) => issues.push({ side, code, name, required, actual })
  if (options.revoked) add("package", "REVOKED", manifest.id, "non-revoked package", manifest.version)
  if (prerelease(manifest.version) && !options.allowPrerelease) add("package", "PRERELEASE", manifest.id, "stable release", manifest.version)
  for (const side of ["client", "host"] as const) {
    const descriptor = side === "client" ? client : host
    if (!matches(descriptor.appVersion, manifest.engines[side])) add(side, "APP_VERSION", "app", manifest.engines[side], descriptor.appVersion)
    if (!descriptor.manifestVersions.includes(manifest.manifestVersion)) add(side, "MANIFEST_VERSION", "manifest", String(manifest.manifestVersion), descriptor.manifestVersions.join(","))
    if (!descriptor.protocolVersions.includes(manifest.protocol)) add(side, "PROTOCOL_VERSION", "protocol", String(manifest.protocol), descriptor.protocolVersions.join(","))
    if (!descriptor.runtimes.includes(manifest.runtime)) add(side, "RUNTIME", "runtime", manifest.runtime, descriptor.runtimes.join(","))
    for (const [name, required] of Object.entries(manifest.requires[side])) {
      const actual = descriptor.capabilities[name] ?? null
      if (!actual || !matches(actual, required)) add(side, "CAPABILITY", name, required, actual)
    }
    for (const [name, required] of Object.entries(manifest.optional[side])) {
      const actual = descriptor.capabilities[name] ?? null
      if (!actual || !matches(actual, required)) unavailableOptional.push({ side, name, required, actual })
    }
  }
  for (const prerequisite of manifest.browser) {
    if (!client.browser.includes(prerequisite)) add("client", "BROWSER", prerequisite, "available", null)
  }
  const common: string[] = []
  const apiRange = new Range(manifest.engines.pluginApi, { includePrerelease: options.allowPrerelease === true })
  for (const clientVersion of client.apiVersions.filter((version) => valid(version))) {
    for (const hostVersion of host.apiVersions.filter((version) => valid(version))) {
      if (major(clientVersion) !== major(hostVersion)) continue
      const ceiling = compare(clientVersion, hostVersion) <= 0 ? clientVersion : hostVersion
      if (matches(ceiling, manifest.engines.pluginApi)) common.push(ceiling)
      for (const clause of apiRange.set) {
        const intersection = `${clause.map((comparator) => comparator.value).join(" ")} >=${major(ceiling)}.0.0 <=${ceiling}`
        const candidate = minVersion(intersection)?.version
        if (candidate && matches(candidate, manifest.engines.pluginApi)) common.push(candidate)
      }
    }
  }
  const apiVersion = common.sort(rcompare)[0] ?? null
  if (!apiVersion) {
    for (const side of ["client", "host"] as const) {
      const versions = side === "client" ? client.apiVersions : host.apiVersions
      if (!versions.some((version) => matches(version, manifest.engines.pluginApi))) add(side, "API_VERSION", "pluginApi", manifest.engines.pluginApi, versions.join(","))
    }
    if (!issues.some((issue) => issue.code === "API_VERSION")) add("host", "API_VERSION", "pluginApi", "common API version", host.apiVersions.join(","))
  }
  return { compatible: issues.length === 0, apiVersion, issues, unavailableOptional }
}
