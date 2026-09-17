// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { appSeedClientDescriptor, loadAppPluginSeeds } from "../../plugins/appSeeds"
import { captureLegacyPluginHost } from "../../plugins/legacyHost"
import { pluginRuntimeDescriptor } from "../../plugins/runtime"
import { openPluginStore, type PluginStore } from "../../plugins/store"

const ids = ["cogpit.clickup", "cogpit.cloudflare", "cogpit.github", "cogpit.vercel"]
const legacyIds = ["cogpit.clickup", "cogpit.github", "cogpit.vercel"]
const SLOW = process.platform === "win32" ? 60_000 : 20_000
const seeds = loadAppPluginSeeds()
const client = appSeedClientDescriptor()
const authorize = async () => {}
let directory: string
const opened: PluginStore[] = []
const sortedIds = (values: { id: string }[]) => values.map(value => value.id).sort()
async function open() {
  const legacyHost = await captureLegacyPluginHost(directory)
  const store = await openPluginStore(join(directory, "runtime-plugins"), { host: pluginRuntimeDescriptor(), appSeeds: loadAppPluginSeeds(), legacyHost })
  opened.push(store)
  expect(store.snapshot().available).toBe(true)
  return store
}
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "cogpit-bundled-rollout-")) })
afterEach(async () => { for (const store of opened.splice(0)) await store.close(); await rm(directory, { recursive: true, force: true }) })

describe("actual bundled optional plugin rollout", () => {
  it("migrates the three legacy packages on a legacy host and leaves newer packages for explicit installation", async () => {
    expect(sortedIds(seeds)).toEqual(ids)
    await writeFile(join(directory, "config.local.json"), JSON.stringify({ useBuiltInEditor: true }))
    const store = await open()
    const result = await store.migrateLegacySeeds({ client, authorize })
    expect(result.failures).toEqual([])
    expect(sortedIds(result.snapshot.plugins)).toEqual(legacyIds)
    expect(result.snapshot.legacyPluginIds).toEqual([])
    for (const seed of seeds.filter(seed => legacyIds.includes(seed.id))) {
      expect(result.snapshot.plugins.find(plugin => plugin.id === seed.id)).toMatchObject({ selectedDigest: seed.payloadDigest, enabled: true, pinned: false, scope: { type: "all" } })
      expect(await store.payload(seed.payloadDigest)).toEqual(seed.payload)
    }
    expect(result.snapshot.availableSeeds!.map(seed => seed.manifest.id).sort()).toEqual(ids)
    const trust = JSON.parse(await readFile(join(directory, "runtime-plugins", "trust.json"), "utf8"))
    expect(trust.publishers).toEqual({})
    expect(Object.keys(trust.appSeeds).sort()).toEqual(seeds.filter(seed => legacyIds.includes(seed.id)).map(seed => seed.payloadDigest).sort())
    const registry = JSON.parse(await readFile(join(directory, "runtime-plugins", "registry.json"), "utf8"))
    expect(registry.seedMigration.decisions["cogpit.cloudflare"]).toBe("fresh")
    expect((await store.migrateLegacySeeds({ client, authorize })).snapshot.revision).toBe(result.snapshot.revision)
  }, SLOW)

  it("keeps fresh hosts empty while exposing every bundled package for explicit reviewed installation", async () => {
    const store = await open()
    const migrated = await store.migrateLegacySeeds({ client, authorize })
    expect(migrated).toMatchObject({ failures: [], snapshot: { plugins: [], legacyPluginIds: [] } })
    expect(migrated.snapshot.availableSeeds!.map(seed => seed.manifest.id).sort()).toEqual(ids)
    for (const seed of seeds) {
      const preview = await store.stageSeed(seed.id, { owner: "reviewing-client", client, scope: { type: "all" }, authorize })
      expect(preview.compatibility.compatible).toBe(true)
      expect(preview.digest).toBe(seed.payloadDigest)
      expect(store.snapshot().plugins).toEqual([])
      await expect(store.commit(preview.transactionId, "reviewing-client", { expectedRevision: preview.registryRevision, authorize })).rejects.toMatchObject({ code: "TRIAL_EXPIRED" })
      await store.cancel(preview.transactionId, "reviewing-client", { authorize })
    }
    await store.close()
    await writeFile(join(directory, "config.local.json"), JSON.stringify({ useBuiltInEditor: true }))
    const restarted = await open()
    expect((await restarted.migrateLegacySeeds({ client, authorize })).snapshot.plugins).toEqual([])
    expect(restarted.snapshot().availableSeeds!.map(seed => seed.manifest.id).sort()).toEqual(ids)
  }, SLOW)

  it("preserves disabled, pinned and uninstalled choices when the same app seeds are loaded again", async () => {
    await writeFile(join(directory, "config.local.json"), JSON.stringify({ useBuiltInEditor: true }))
    let store = await open()
    expect((await store.migrateLegacySeeds({ client, authorize })).failures).toEqual([])
    await store.setEnabled("cogpit.github", false, { expectedRevision: store.snapshot().revision, authorize })
    await store.setPin("cogpit.vercel", true, { expectedRevision: store.snapshot().revision, authorize })
    await store.uninstall("cogpit.clickup", { expectedRevision: store.snapshot().revision, authorize })
    for (let restart = 0; restart < 2; restart++) {
      await store.close()
      store = await open()
      const result = await store.migrateLegacySeeds({ client, authorize })
      expect(result.failures).toEqual([])
      expect(sortedIds(result.snapshot.plugins)).toEqual(["cogpit.github", "cogpit.vercel"])
      expect(result.snapshot.plugins.find(plugin => plugin.id === "cogpit.github")).toMatchObject({ enabled: false, selectedDigest: seeds.find(seed => seed.id === "cogpit.github")!.payloadDigest })
      expect(result.snapshot.plugins.find(plugin => plugin.id === "cogpit.vercel")).toMatchObject({ enabled: true, pinned: true, selectedDigest: seeds.find(seed => seed.id === "cogpit.vercel")!.payloadDigest })
      expect(result.snapshot.legacyPluginIds).toEqual([])
      expect(result.snapshot.availableSeeds!.map(seed => seed.manifest.id).sort()).toEqual(ids)
    }
    const registry = JSON.parse(await readFile(join(directory, "runtime-plugins", "registry.json"), "utf8"))
    expect(registry.seedMigration.decisions).toEqual({ "cogpit.clickup": "uninstalled", "cogpit.cloudflare": "fresh", "cogpit.github": "imported", "cogpit.vercel": "imported" })
  }, SLOW)
})
