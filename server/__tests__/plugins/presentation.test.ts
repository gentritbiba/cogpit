// @vitest-environment node
import { describe, expect, it } from "vitest"
import { parseConnectionDefinition, parseManifest } from "@cogpit/plugin-contracts"
import { pluginSnapshotForClient, canReadConnection } from "../../plugins/presentation"
import { client } from "./fixtures/storeSigning"

const legacy = parseManifest({ manifestVersion: 1, id: "example.panel", publisher: "example", name: "Panel", version: "1.0.0", runtime: "browser-iife-v1", entry: "plugin.js", engines: { pluginApi: "^1.0.0", client: "*", host: "*" }, requires: { client: {}, host: {} }, contributes: { panels: [{ id: "panel", title: "Panel", icon: "icon.png" }] }, permissions: {}, stateVersion: 1 })
const modern = parseManifest({ ...legacy, version: "2.0.0", contributes: { ...legacy.contributes, settings: { scope: "plugin", fields: [{ id: "enabled", label: "Enabled", type: "boolean", default: true }] } } })
const previous = { digest: "a".repeat(64), manifest: legacy, targetPath: "legacy", installedAt: 1 }
const latest = { ...previous, digest: "b".repeat(64), manifest: modern }
describe("plugin DTO compatibility", () => {
  it("filters unsupported retained versions and catalog entries without hiding legacy panels", () => {
    const snapshot = { available: true, revision: 7, publishers: [], plugins: [{ id: legacy.id, selectedDigest: previous.digest, manifest: legacy, enabled: true, scope: { type: "all" as const }, pinned: true, versions: [previous, latest] }], availableSeeds: [{ manifest: modern, digest: latest.digest }] }
    const old = pluginSnapshotForClient(snapshot, { ...client, apiVersions: ["1.1.0"] })
    expect(old.plugins[0].versions).toEqual([previous])
    expect(old.plugins[0].manifest).toEqual(legacy)
    expect(old.availableSeeds).toEqual([])
    expect(pluginSnapshotForClient(snapshot, { ...client, apiVersions: ["1.2.0"] })).toEqual(snapshot)
    expect(snapshot.plugins[0].versions).toHaveLength(2)
  })
  it("prevents old clients from receiving newly introduced connection properties", () => {
    const operation = { audience: "setup", method: "GET", origin: "https://api.example.com", path: [{ literal: "items" }], args: {}, query: {} }
    const definition = parseConnectionDefinition({ version: 1, id: "service", label: "Service", secret: { id: "key", label: "Key" }, auth: { header: "Authorization", scheme: "bearer" }, validationOperation: "validate", resources: {}, operations: { validate: operation, search: { ...operation, audience: "panel", args: { text: { type: "string", multiline: false, maxLength: 100 } }, query: { text: "text" } } } })
    expect(canReadConnection(definition, { ...client, apiVersions: ["1.1.0"] })).toBe(false)
    expect(canReadConnection(definition, { ...client, apiVersions: ["1.2.0"] })).toBe(true)
  })
  it("keeps dictation, icon buttons and recording uploads from clients older than API 1.3", () => {
    const operation = { audience: "setup", method: "GET", origin: "https://api.example.com", path: [{ literal: "me" }], args: {}, query: {} }
    const definition = parseConnectionDefinition({ version: 1, id: "speech", label: "Speech", secret: { id: "key", label: "Key" }, auth: { header: "Authorization", scheme: "bearer" }, validationOperation: "validate", resources: {},
      operations: { validate: operation, transcribe: { ...operation, audience: "panel", method: "POST", path: [{ literal: "transcribe" }], upload: { type: "audio", mimeTypes: ["audio/wav"], maxBytes: 1024 } } } })
    expect(canReadConnection(definition, { ...client, apiVersions: ["1.2.0"] })).toBe(false)
    expect(canReadConnection(definition, { ...client, apiVersions: ["1.3.0"] })).toBe(true)
    const skill = { id: "speech", title: "Speech", description: "Speak", source: "SKILL.md" }
    const dictating = parseManifest({ ...legacy, version: "3.0.0", contributes: { ...legacy.contributes, dictation: { title: "Dictate", connection: "speech", operation: "transcribe", text: "/text" } },
      permissions: { connections: [{ id: "speech", definition: "speech.json", operations: ["transcribe"] }] } })
    const iconic = parseManifest({ ...legacy, version: "3.0.0", contributes: { ...legacy.contributes, skills: [skill], sessionActions: [{ id: "summary", title: "Summary", icon: "speaker", skill: "speech", prompt: "Summarize." }] } })
    for (const manifest of [dictating, iconic]) {
      const snapshot = { available: true, revision: 1, publishers: [], plugins: [{ id: manifest.id, selectedDigest: latest.digest, manifest, enabled: true, scope: { type: "all" as const }, pinned: false, versions: [{ ...latest, manifest }] }] }
      expect(pluginSnapshotForClient(snapshot, { ...client, apiVersions: ["1.2.0"] }).plugins).toEqual([])
      expect(pluginSnapshotForClient(snapshot, { ...client, apiVersions: ["1.3.0"] })).toEqual(snapshot)
    }
  })
})
