// @vitest-environment node
import { describe, expect, it } from "vitest"
import { evaluateCompatibility, parseManifest, type PluginManifest } from "@cogpit/plugin-contracts"
import { clientImpact } from "../../plugins/clientImpact"
import type { PluginInstallPreview } from "../../../shared/contracts/plugins"
import { client, host } from "./fixtures/storeSigning"

function preview(overrides: Partial<PluginManifest> = {}): PluginInstallPreview {
  const manifest = parseManifest({ manifestVersion: 1, id: "example.probe", publisher: "example", name: "Probe", version: "1.0.0", runtime: "browser-iife-v1", entry: "plugin.js", engines: { client: ">=2.0.0", host: ">=2.0.0", pluginApi: "^1.0.0" }, requires: { client: {}, host: {} }, contributes: { panels: [{ id: "probe", title: "Probe", icon: "icon.png" }] }, permissions: {}, stateVersion: 1, ...overrides })
  return { transactionId: "00000000-0000-4000-8000-000000000000", manifest, digest: "a".repeat(64), compatibility: evaluateCompatibility(manifest, client, host), oldVersion: "0.9.0", registryRevision: 1, publisherKind: "official", scope: { type: "all" }, connectionDefinitions: [] }
}

describe("connected client impact", () => {
  it("omits warnings for compatible clients and clients with only an unknown app version", () => {
    const candidate = preview()
    expect(clientImpact(candidate, [client, { ...client, appVersion: "unknown" }], host).incompatibleClients).toBeUndefined()
    expect(clientImpact(candidate, [], host).incompatibleClients).toBeUndefined()
  })

  it("reports app and API incompatibility using anonymous coarse versions", () => {
    const clients = [{ ...client, appVersion: "1.8.1" }, { ...client, appVersion: "2.6.6", apiVersions: ["2.0.0"] }]
    expect(clientImpact(preview(), clients, host).incompatibleClients).toEqual(["Cogpit 1.8 · API 1.0", "Cogpit 2.6 · API 2.0"])
  })

  it("reports browser or capability requirements but ignores unavailable optional features", () => {
    const required = preview({ browser: ["web-crypto"], requires: { client: { "workspace.panel": "^1.0.0" }, host: {} } })
    expect(clientImpact(required, [client], host).incompatibleClients).toEqual(["Cogpit 2.6 · API 1.0"])
    const optional = preview({ optional: { client: { "workspace.panel": "^1.0.0" }, host: {} } })
    expect(clientImpact(optional, [client], host).incompatibleClients).toBeUndefined()
    expect(clientImpact(preview({ browser: ["web-crypto"] }), [{ ...client, browser: [] }], host).incompatibleClients).toHaveLength(1)
  })

  it("does not blame clients for host-only or package-only incompatibility", () => {
    expect(clientImpact(preview({ requires: { client: {}, host: { "provider.unavailable": "^1.0.0" } } }), [client], host).incompatibleClients).toBeUndefined()
    expect(clientImpact(preview({ version: "1.0.0-beta.1" }), [client], host).incompatibleClients).toBeUndefined()
  })

  it("detects disjoint API majors even when both satisfy the package's broad range", () => {
    const candidate = preview({ engines: { client: ">=2.0.0", host: ">=2.0.0", pluginApi: ">=1.0.0" } })
    expect(clientImpact(candidate, [client], { ...host, apiVersions: ["2.0.0"] }).incompatibleClients).toEqual(["Cogpit 2.6 · API 1.0"])
  })

  it("deduplicates patch versions and never echoes version metadata or unrecognized version text", () => {
    const clients = [{ ...client, appVersion: "1.8.1+private-user-label" }, { ...client, appVersion: "1.8.2+another-label" }, { ...client, appVersion: "/private/host/token", browser: [] }]
    const result = clientImpact(preview({ browser: ["web-crypto"] }), clients, host)
    expect(result.incompatibleClients).toEqual(["Cogpit 1.8 · API 1.0", "Cogpit unknown · API 1.0"])
    expect(JSON.stringify(result.incompatibleClients)).not.toMatch(/private|token|label/)
  })

  it("returns a detached preview and replaces stale impact warnings", () => {
    const candidate = preview()
    candidate.incompatibleClients = ["old warning"]
    const result = clientImpact(candidate, [client], host)
    result.manifest.name = "Changed"
    expect(candidate.manifest.name).toBe("Probe")
    expect(candidate.incompatibleClients).toEqual(["old warning"])
    expect(result.incompatibleClients).toBeUndefined()
  })

  it("bounds warning count and label length", () => {
    const clients = Array.from({ length: 512 }, (_, index) => ({ ...client, appVersion: `1.${index}.0`, apiVersions: Array.from({ length: 16 }, (_, api) => `999999999999999.${api}.0`) }))
    const warnings = clientImpact(preview(), clients, host).incompatibleClients!
    expect(warnings).toHaveLength(256)
    expect(warnings.every(warning => warning.length <= 256)).toBe(true)
  })
})
