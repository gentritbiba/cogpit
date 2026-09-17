import { hostname } from "node:os"
import { PLUGIN_API_VERSION, PROTOCOL_MAJOR, RUNTIME, type HostRuntimeDescriptor } from "@cogpit/plugin-contracts"
import { getAppVersion, getInstanceId } from "../routes/hello"

export function pluginRuntimeDescriptor(registryRevision = 0): HostRuntimeDescriptor & { instanceId: string; name: string } {
  return {
    appVersion: getAppVersion(),
    apiVersions: [PLUGIN_API_VERSION],
    manifestVersions: [1],
    protocolVersions: [PROTOCOL_MAJOR],
    runtimes: [RUNTIME],
    capabilities: { "connections.request": "1.0.0", "storage.json": "1.0.0", "integrations.github": "1.0.0", "integrations.vercel": "1.0.0", "integrations.cloudflare": "1.0.0" },
    platform: process.platform,
    registryRevision,
    instanceId: getInstanceId(),
    name: process.env.COGPIT_DEVICE_NAME || hostname(),
  }
}
