import { PLUGIN_API_VERSION, PROTOCOL_MAJOR, RUNTIME, type ClientRuntimeDescriptor } from "@cogpit/plugin-contracts"
import seeds from "../../generated/runtime-plugin-seeds/index.json"
import { version } from "../../package.json"
import type { AppPluginSeed } from "./seeds"

export function loadAppPluginSeeds(): AppPluginSeed[] {
  return seeds.map((seed) => ({ ...seed, payload: Buffer.from(seed.payload, "base64") }))
}

export function appSeedClientDescriptor(): ClientRuntimeDescriptor {
  return {
    appVersion: version, apiVersions: [PLUGIN_API_VERSION], manifestVersions: [1], protocolVersions: [PROTOCOL_MAJOR],
    runtimes: [RUNTIME], capabilities: { "workspace.panel": "1.0.0", "composer.append": "1.0.0", "navigation.external": "1.0.0", "navigation.session": "1.0.0" },
    browser: ["message-channel", "blob-script", "web-crypto"],
  }
}
