import { parseManifest, type ClientRuntimeDescriptor } from "@cogpit/plugin-contracts"
import type { InstalledPlugin } from "../../../shared/contracts/plugins"
import type { PluginHostStatus } from "../../../shared/contracts/pluginManagement"
import type { WorkspacePanelContext } from "@/plugin-api"

export const panelManifest = parseManifest({
  manifestVersion: 1, id: "example.sample", publisher: "example", name: "Sample", version: "1.0.0", runtime: "browser-iife-v1", entry: "dist/plugin.js",
  engines: { pluginApi: "^1.0.0", host: ">=2.7.0", client: ">=2.7.0" }, requires: { client: {}, host: {} },
  contributes: { panels: [{ id: "sample", title: "Sample", icon: "assets/icon.png" }] }, permissions: {}, stateVersion: 1,
})
export const panelPlugin: InstalledPlugin = { id: panelManifest.id, selectedDigest: "a".repeat(64), manifest: panelManifest, enabled: true, scope: { type: "all" }, pinned: false,
  versions: [{ digest: "a".repeat(64), manifest: panelManifest, targetPath: "sample.cogpit-plugin", installedAt: 1 }] }
export const panelProject = { id: `p_${"a".repeat(40)}`, name: "Sample project", paths: ["/private/repo"] }
export const panelWorkspace: WorkspacePanelContext = { session: null, sessionChangeKey: 1, projectPath: "/private/repo", hasFileChanges: false, canAccessHostFiles: true }
export const panelClientDescriptor: ClientRuntimeDescriptor = { appVersion: "2.7.0", apiVersions: ["1.0.0"], manifestVersions: [1], protocolVersions: [1], runtimes: ["browser-iife-v1"], capabilities: {}, browser: ["message-channel", "blob-script", "web-crypto"] }
export const panelHostStatus: PluginHostStatus = { runtime: { ...panelClientDescriptor, platform: "linux", registryRevision: 1 }, host: { name: "Host", instanceId: "host-1" },
  store: { available: true, revision: 1, plugins: [panelPlugin], publishers: [] }, projects: [panelProject], safeMode: false }
