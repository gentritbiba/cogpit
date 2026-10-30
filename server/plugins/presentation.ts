import { satisfies } from "semver"
import type { ClientRuntimeDescriptor, PluginManifest, ConnectionDefinition } from "@cogpit/plugin-contracts"
import type { PluginStoreSnapshot } from "../../shared/contracts/plugins"

const supportsApi = (client: ClientRuntimeDescriptor | undefined, minimum: string) => client?.apiVersions.some(version => satisfies(version, `>=${minimum} <2.0.0`)) === true
const supportsContributions = (client?: ClientRuntimeDescriptor) => supportsApi(client, "1.2.0")
/** API 1.3.0 added dictation, icon buttons and recording uploads, which a 1.2 client's strict schemas reject. */
const supportsRecording = (client?: ClientRuntimeDescriptor) => supportsApi(client, "1.3.0")

export function canReadPluginManifest(manifest: PluginManifest, client?: ClientRuntimeDescriptor): boolean {
  if (supportsRecording(client)) return true
  if (manifest.contributes.dictation || manifest.contributes.sessionActions?.some(action => action.icon)) return false
  if (supportsContributions(client)) return true
  return !!manifest.entry && manifest.contributes.panels.length > 0
    && manifest.contributes.settings === undefined && manifest.contributes.skills === undefined
    && manifest.contributes.chatBlocks === undefined && manifest.contributes.sessionActions === undefined
}

export function canReadConnection(definition: ConnectionDefinition, client?: ClientRuntimeDescriptor): boolean {
  if (supportsRecording(client)) return true
  if (Object.values(definition.operations).some(operation => operation.upload)) return false
  return supportsContributions(client) || Object.values(definition.operations).every(operation => operation.method === "GET" && !operation.body && !operation.response
    && Object.values(operation.args).every(argument => argument.type !== "number" && (argument.type !== "string" || argument.multiline === undefined && argument.maxLength <= 1024 && (argument.enum?.length ?? 0) <= 32)))
}

export function pluginSnapshotForClient(snapshot: PluginStoreSnapshot, client?: ClientRuntimeDescriptor): PluginStoreSnapshot {
  const plugins = snapshot.plugins.filter(plugin => canReadPluginManifest(plugin.manifest, client)).map(plugin => ({ ...plugin, versions: plugin.versions.filter(version => canReadPluginManifest(version.manifest, client)) }))
  const availableSeeds = snapshot.availableSeeds?.filter(seed => canReadPluginManifest(seed.manifest, client))
  const hidden = plugins.length !== snapshot.plugins.length || availableSeeds?.length !== snapshot.availableSeeds?.length
  return { ...snapshot, plugins, ...(availableSeeds ? { availableSeeds } : {}),
    ...(hidden ? { error: snapshot.error ?? "Some plugins require a newer Cogpit client. Existing compatible panels remain available." } : {}),
  }
}
