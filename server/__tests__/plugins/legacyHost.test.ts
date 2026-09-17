// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureLegacyPluginHost, remainingLegacyPluginIds } from "../../plugins/legacyHost"
let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "cogpit-host-classification-")) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

describe("pre-setup host classification", () => {
  it("can classify a missing host root before setup creates it", async () => {
    expect(await captureLegacyPluginHost(join(directory, "new-host"))).toMatchObject({ classification: "fresh", evidence: "no-config" })
  })
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("returns indeterminate when the classification location is read-only instead of failing core startup", async () => {
    await chmod(directory, 0o500)
    try { expect(await captureLegacyPluginHost(directory)).toMatchObject({ classification: "indeterminate", evidence: "classification-unavailable" }) }
    finally { await chmod(directory, 0o700) }
  })
  it("records fresh before first-run config writes and never reclassifies on restart", async () => {
    const first = await captureLegacyPluginHost(directory)
    expect(first).toMatchObject({ classification: "fresh", evidence: "no-config" })
    await writeFile(join(directory, "config.local.json"), JSON.stringify({ useBuiltInEditor: true }))
    expect(await captureLegacyPluginHost(directory)).toEqual(first)
    const path = join(directory, "plugin-host-classification", "host.json")
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(first)
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
  it("uses a runtime-era config marker when initial classification persistence was unavailable", async () => {
    await writeFile(join(directory, "config.local.json"), JSON.stringify({ useBuiltInEditor: true, runtimePluginsVersion: 1 }))
    expect(await captureLegacyPluginHost(directory)).toMatchObject({ classification: "fresh", evidence: "runtime-config" })
  })
  it("retains an earlier legacy classification after normal config writes add the runtime marker", async () => {
    await writeFile(join(directory, "config.local.json"), JSON.stringify({ useBuiltInEditor: true }))
    const captured = await captureLegacyPluginHost(directory)
    await writeFile(join(directory, "config.local.json"), JSON.stringify({ useBuiltInEditor: true, runtimePluginsVersion: 1 }))
    expect(await captureLegacyPluginHost(directory)).toEqual(captured)
  })
  it.each([2, "1", null])("refuses an unknown or malformed runtime-era marker %s", async (runtimePluginsVersion) => {
    await writeFile(join(directory, "config.local.json"), JSON.stringify({ useBuiltInEditor: true, runtimePluginsVersion }))
    expect(await captureLegacyPluginHost(directory)).toMatchObject({ classification: "indeterminate", evidence: "invalid-config" })
  })
  it("records existing Cogpit config while ignoring credentials and agent/session evidence", async () => {
    await writeFile(join(directory, "clickup.json"), JSON.stringify({ token: "fixture-private-token" }))
    await writeFile(join(directory, "history.jsonl"), "fixture history")
    expect((await captureLegacyPluginHost(directory)).classification).toBe("fresh")
    const another = await mkdtemp(join(tmpdir(), "cogpit-existing-config-"))
    try {
      await writeFile(join(another, "config.local.json"), JSON.stringify({ terminalApp: "terminal", networkPassword: "never-record-this" }))
      const existing = await captureLegacyPluginHost(another)
      expect(existing).toMatchObject({ classification: "legacy", evidence: "config.local.json" })
      expect(JSON.stringify(existing)).not.toContain("never-record-this")
      expect(JSON.stringify(existing)).not.toContain(another)
      await rm(join(another, "config.local.json"))
      expect(await captureLegacyPluginHost(another)).toEqual(existing)
    } finally { await rm(another, { recursive: true, force: true }) }
  })
  it.each(["{bad", "[]", "{}", "null", '"config"', '{"key":1,"key":2}', '{"unknown":true}', '{"networkPassword":"credential-only"}', '{"networkAccess":"yes"}'])("does not treat malformed existing config as fresh: %s", async (contents) => {
    await writeFile(join(directory, "config.local.json"), contents)
    expect(await captureLegacyPluginHost(directory)).toMatchObject({ classification: "indeterminate", evidence: "invalid-config" })
  })
  it("does not follow config symlinks", async () => {
    const target = join(directory, "other.json")
    await writeFile(target, JSON.stringify({ terminalApp: "terminal" }))
    await symlink(target, join(directory, "config.local.json"))
    expect((await captureLegacyPluginHost(directory)).classification).toBe("indeterminate")
  })
  it.each(["{broken", '{"formatVersion":2,"minWriterVersion":2,"classification":"fresh"}'])("preserves invalid/future classification records without fallback: %s", async (text) => {
    await captureLegacyPluginHost(directory)
    const path = join(directory, "plugin-host-classification", "host.json")
    await writeFile(path, text)
    expect(await captureLegacyPluginHost(directory)).toMatchObject({ classification: "indeterminate", evidence: "classification-unavailable" })
    expect(await readFile(path, "utf8")).toBe(text)
  })
  it("filters legacy aliases after migration/uninstall and hides all legacy panels on fresh hosts", async () => {
    const fresh = await captureLegacyPluginHost(directory)
    expect(remainingLegacyPluginIds(fresh)).toEqual([])
    const legacy = { ...fresh, classification: "legacy" as const, evidence: "config.local.json" as const }
    expect(remainingLegacyPluginIds(legacy, { "cogpit.clickup": "imported" })).toEqual(["github", "vercel-deployments"])
    expect(remainingLegacyPluginIds(legacy, { "cogpit.clickup": "uninstalled", "cogpit.github": "preserved" })).toEqual(["vercel-deployments"])
    expect(remainingLegacyPluginIds()).toEqual(["github", "clickup", "vercel-deployments"])
  })
})
