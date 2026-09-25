import { createHash } from "node:crypto"
import { parseManifest, type ClientRuntimeDescriptor, type HostRuntimeDescriptor, type ConnectionDefinition } from "@cogpit/plugin-contracts"
import { createBundle, replaceTargets, type Authority } from "./signing"

export const authorize = async () => {}
export const owner = "opaque-session-owner"
export const host: HostRuntimeDescriptor = { appVersion: "2.6.6", apiVersions: ["1.0.0"], manifestVersions: [1], protocolVersions: [1], runtimes: ["browser-iife-v1"], capabilities: {}, platform: process.platform, registryRevision: 0 }
export const client: ClientRuntimeDescriptor = { appVersion: "2.6.6", apiVersions: ["1.0.0"], manifestVersions: [1], protocolVersions: [1], runtimes: ["browser-iife-v1"], capabilities: {}, browser: ["message-channel", "blob-script", "web-crypto"] }
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
export interface SignedPackage { bytes: Buffer; payload: Buffer; digest: string; targetPath: string; manifest: ReturnType<typeof parseManifest> }
export function signedPackage(authority: Authority, options: { version?: string; metadataVersion?: number; stateVersion?: number; retained?: SignedPackage[]; script?: string; targetSuffix?: string; id?: string; publisher?: string; connection?: ConnectionDefinition; composer?: boolean; navigation?: boolean; storage?: { scope: "project" | "plugin"; quotaKiB: number } } = {}): SignedPackage {
  const publisher = options.publisher ?? "dev-test"
  const manifest = parseManifest({ manifestVersion: 1, id: options.id ?? `${publisher}.probe`, publisher, name: "Store probe", version: options.version ?? "1.0.0", runtime: "browser-iife-v1", entry: "plugin.js", engines: { pluginApi: "^1.0.0", client: ">=2.0.0", host: ">=2.0.0" }, requires: { client: {}, host: {} }, contributes: { panels: [{ id: "probe", title: "Probe", icon: "icon.png" }] }, permissions: { storage: options.storage ?? { scope: "project", quotaKiB: 16 }, composer: options.composer ? ["append"] : [], navigation: options.navigation ? ["external"] : [], connections: options.connection ? [{ id: options.connection.id, definition: "connection.json", operations: Object.entries(options.connection.operations).filter(([, operation]) => operation.audience === "panel").map(([id]) => id) }] : [] }, stateVersion: options.stateVersion ?? 1 })
  const file = (path: string, mime: string, bytes: Buffer) => ({ path, mime, content: bytes.toString("base64") })
  const payload = Buffer.from(JSON.stringify({ archiveVersion: 1, files: [
    file("plugin.json", "application/json", Buffer.from(JSON.stringify(manifest))),
    file("plugin.js", "text/javascript", Buffer.from(options.script ?? "document.body.textContent = 'Store probe'")),
    file("icon.png", "image/png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64")),
    ...options.connection ? [file("connection.json", "application/json", Buffer.from(JSON.stringify(options.connection)))] : [],
  ] }))
  const targetPath = `${manifest.publisher}/${manifest.id}/${manifest.version}/${options.targetSuffix ?? "payload"}.json`
  const unsigned = createBundle(authority, { payload, version: options.metadataVersion ?? 1 })
  const bundle = replaceTargets(unsigned, authority, value => {
    value.signed.targets = Object.fromEntries([{ payload, targetPath, manifest }, ...options.retained ?? []].map(candidate => [candidate.targetPath, { length: candidate.payload.length, hashes: { sha256: hash(candidate.payload) }, custom: { publisher: candidate.manifest.publisher, pluginId: candidate.manifest.id, version: candidate.manifest.version } }]))
  })
  const bytes = Buffer.from(JSON.stringify({ bundleVersion: 1, publisher: manifest.publisher, targetPath, roots: [], metadata: Object.fromEntries([...bundle.metadata].map(([name, bytes]) => [name, bytes.toString("utf8")])), payload: payload.toString("base64") }))
  return { bytes, payload, digest: hash(payload), targetPath, manifest }
}
