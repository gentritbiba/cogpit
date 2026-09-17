import { evaluateCompatibility, type ClientRuntimeDescriptor, type HostRuntimeDescriptor } from "@cogpit/plugin-contracts"
import { major, minor, valid } from "semver"
import type { PluginInstallPreview } from "../../shared/contracts/plugins"

const coarseVersion = (version: string): string | null => valid(version) ? `${major(version)}.${minor(version)}` : null

export function clientImpact(preview: PluginInstallPreview, clients: readonly ClientRuntimeDescriptor[], host: HostRuntimeDescriptor): PluginInstallPreview {
  const warnings = new Set<string>()
  for (const client of clients) {
    const compatibility = evaluateCompatibility(preview.manifest, client, host, { allowPrerelease: preview.publisherKind === "development" })
    const knownApp = coarseVersion(client.appVersion)
    const incompatible = compatibility.issues.some(issue =>
      issue.side === "client" && (issue.code !== "APP_VERSION" || knownApp !== null)
      || issue.code === "API_VERSION" && issue.required === "common API version")
    if (!incompatible) continue
    const api = [...new Set(client.apiVersions.map(coarseVersion).filter((version): version is string => version !== null))].sort().join(", ") || "unavailable"
    warnings.add(`Cogpit ${knownApp ?? "unknown"} · API ${api}`.slice(0, 256))
    if (warnings.size === 256) break
  }
  const result = structuredClone(preview)
  delete result.incompatibleClients
  if (warnings.size) result.incompatibleClients = [...warnings]
  return result
}
