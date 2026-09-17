// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openPluginStore, type PluginStore, type PluginStoreOptions } from "../../plugins/store"
import { captureAppSeeds, type AppPluginSeed } from "../../plugins/seeds"
import { captureLegacyPluginHost, type LegacyHostClassification } from "../../plugins/legacyHost"
import { createAuthority, createRoot, type Authority } from "./fixtures/signing"
import { authorize, client, host, owner, signedPackage, type SignedPackage } from "./fixtures/storeSigning"

let directory: string, root: string, authority: Authority, legacy: LegacyHostClassification, first: SignedPackage
const opened: PluginStore[] = []
const stageOptions = { owner, client, scope: { type: "all" as const }, authorize }
const seed = (candidate = first, appVersion = "2.6.6"): AppPluginSeed => ({ id: candidate.manifest.id, publisher: candidate.manifest.publisher, targetPath: candidate.targetPath, appVersion, payloadDigest: candidate.digest, payload: candidate.payload })
async function open(options: Partial<PluginStoreOptions> = {}) {
  const store = await openPluginStore(root, { host, appSeeds: [seed()], legacyHost: legacy, ...options }); opened.push(store); return store
}
async function install(store: PluginStore, candidate: SignedPackage) {
  const preview = await store.stage(candidate.bytes, stageOptions)
  await store.payload(preview.transactionId, owner); await store.beginTrial(preview.transactionId, owner, { authorize })
  await store.commit(preview.transactionId, owner, { authorize, expectedRevision: preview.registryRevision })
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cogpit-app-seeds-")); root = join(directory, "plugins")
  authority = createAuthority()
  first = signedPackage(authority, { publisher: "cogpit", id: "cogpit.clickup" })
  await writeFile(join(directory, "config.local.json"), JSON.stringify({ useBuiltInEditor: true }))
  legacy = await captureLegacyPluginHost(directory)
})
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
  await rm(directory, { recursive: true, force: true })
})

describe("app-release seed trust and imports", () => {
  it("repairs exact app-seed bytes without restoring activation or losing the damaged file", async () => {
    let store = await open()
    await store.migrateLegacySeeds({ client, authorize }); await store.close()
    await writeFile(join(root, "packages", `${first.digest}.json`), "damaged seed")
    store = await open()
    expect(store.snapshot().plugins[0].enabled).toBe(false)
    const preview = await store.stageSeed(first.manifest.id, stageOptions)
    expect(await store.payload(preview.transactionId, owner)).toEqual(first.payload)
    await store.beginTrial(preview.transactionId, owner, { authorize })
    await store.commit(preview.transactionId, owner, { expectedRevision: preview.registryRevision, authorize })
    expect(store.snapshot().plugins[0]).toMatchObject({ enabled: false, selectedDigest: first.digest })
    const [backup] = await readdir(join(root, "quarantine"))
    expect(await readFile(join(root, "quarantine", backup), "utf8")).toBe("damaged seed")
  })

  it("refuses bundled repair after newer publisher metadata revokes that exact seed", async () => {
    const store = await open({ officialRoots: new Map([["cogpit", createRoot(authority)]]) })
    await store.migrateLegacySeeds({ client, authorize })
    const newer = signedPackage(authority, { publisher: "cogpit", id: first.manifest.id, version: "1.1.0" })
    const preview = await store.stage(newer.bytes, stageOptions); await store.cancel(preview.transactionId, owner, { authorize })
    await writeFile(join(root, "packages", `${first.digest}.json`), "revoked damaged seed")
    await expect(store.payload(first.digest)).rejects.toMatchObject({ code: "PACKAGE_UNAVAILABLE" })
    await expect(store.stageSeed(first.manifest.id, stageOptions)).rejects.toMatchObject({ code: "UNTRUSTED_PACKAGE" })
    expect(await readdir(join(root, "quarantine"))).toEqual([])
    expect(await readFile(join(root, "packages", `${first.digest}.json`), "utf8")).toBe("revoked damaged seed")
  })

  it("imports exact app-owned bytes on a legacy host with durable provenance and no publisher key", async () => {
    const store = await open()
    expect(store.snapshot()).toMatchObject({ available: true, plugins: [], legacyPluginIds: ["github", "clickup", "vercel-deployments"] })
    const result = await store.migrateLegacySeeds({ client, authorize })
    expect(result.failures).toEqual([])
    expect(result.snapshot.plugins[0]).toMatchObject({ id: "cogpit.clickup", selectedDigest: first.digest, enabled: true, scope: { type: "all" } })
    expect(result.snapshot.legacyPluginIds).toEqual(["github", "vercel-deployments"])
    const trust = JSON.parse(await readFile(join(root, "trust.json"), "utf8"))
    expect(trust.publishers).toEqual({})
    expect(trust.appSeeds[first.digest]).toMatchObject({ digest: first.digest, publisher: "cogpit", pluginId: "cogpit.clickup", appVersion: "2.6.6" })
    expect(JSON.parse(await readFile(join(root, "registry.json"), "utf8")).seedMigration.decisions).toEqual({ "cogpit.clickup": "imported" })
    const journals = await readdir(join(root, "transactions"))
    const journal = JSON.parse(await readFile(join(root, "transactions", journals[0]), "utf8"))
    expect(journal).toMatchObject({ automaticSeedMigration: true, status: "committed", appSeed: { digest: first.digest } })
    expect(journal.deadline).toBeUndefined()
    await store.close()
    const restarted = await open({ appSeeds: [] })
    expect(restarted.snapshot()).toMatchObject({ available: true, plugins: [{ selectedDigest: first.digest }] })
    expect(await restarted.payload(first.digest)).toEqual(first.payload)
  })
  it("fresh hosts install nothing and remain fresh after bootstrap creates config", async () => {
    await rm(join(directory, "config.local.json")); await rm(join(directory, "plugin-host-classification"), { recursive: true })
    const fresh = await captureLegacyPluginHost(directory)
    await writeFile(join(directory, "config.local.json"), JSON.stringify({ useBuiltInEditor: true }))
    const store = await open({ legacyHost: fresh })
    expect(await store.migrateLegacySeeds({ client, authorize })).toMatchObject({ failures: [], snapshot: { plugins: [], legacyPluginIds: [] } })
    await store.close()
    const restarted = await open({ legacyHost: legacy })
    expect((await restarted.migrateLegacySeeds({ client, authorize })).snapshot.plugins).toEqual([])
  })
  it("explicit seed install still requires the normal payload and browser readiness trial", async () => {
    const store = await open({ legacyHost: { ...legacy, classification: "fresh", evidence: "no-config" } })
    const preview = await store.stageSeed("cogpit.clickup", { ...stageOptions, idempotencyKey: "seed-1" })
    expect(await store.stageSeed("cogpit.clickup", { ...stageOptions, idempotencyKey: "seed-1" })).toEqual(preview)
    await expect(store.commit(preview.transactionId, owner, { authorize, expectedRevision: preview.registryRevision })).rejects.toMatchObject({ code: "TRIAL_EXPIRED" })
    await expect(store.beginTrial(preview.transactionId, owner, { authorize })).rejects.toMatchObject({ code: "PAYLOAD_REQUIRED" })
    await store.payload(preview.transactionId, owner); await store.beginTrial(preview.transactionId, owner, { authorize })
    await store.commit(preview.transactionId, owner, { authorize, expectedRevision: preview.registryRevision })
    expect(store.snapshot().plugins[0].selectedDigest).toBe(first.digest)
    expect(store.snapshot().legacyPluginIds).toEqual([])
  })
  it("never trusts uploads through the app-seed digest path or accepts seed paths as IDs", async () => {
    const store = await open()
    await expect(store.stage(first.bytes, stageOptions)).rejects.toMatchObject({ code: "UNKNOWN_PUBLISHER" })
    await expect(store.stageSeed("../../outside.json", stageOptions)).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(store.stageSeed(first.digest, stageOptions)).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect(store.snapshot().plugins).toEqual([])
  })
  it("keeps disabled and uninstalled plugins from reappearing across app upgrades", async () => {
    let store = await open()
    await store.migrateLegacySeeds({ client, authorize })
    await store.setEnabled(first.manifest.id, false, { authorize, expectedRevision: store.snapshot().revision })
    const next = signedPackage(authority, { publisher: "cogpit", id: "cogpit.clickup", version: "1.1.0" })
    await store.close(); store = await open({ appSeeds: [seed(next, "2.7.0")] })
    expect((await store.migrateLegacySeeds({ client, authorize })).snapshot.plugins[0]).toMatchObject({ selectedDigest: first.digest, enabled: false })
    await store.uninstall(first.manifest.id, { authorize, expectedRevision: store.snapshot().revision })
    await store.close(); store = await open({ appSeeds: [seed(next, "2.8.0")] })
    expect((await store.migrateLegacySeeds({ client, authorize })).snapshot.plugins).toEqual([])
    expect(store.snapshot().legacyPluginIds).not.toContain("clickup")
    expect(JSON.parse(await readFile(join(root, "registry.json"), "utf8")).seedMigration.decisions["cogpit.clickup"]).toBe("uninstalled")
  })
  it("does not change a preexisting user-selected or pinned package during migration", async () => {
    const newer = signedPackage(authority, { publisher: "cogpit", id: "cogpit.clickup", version: "2.0.0" })
    const store = await open({ officialRoots: new Map([["cogpit", createRoot(authority)]]) })
    await install(store, newer)
    await store.setPin(first.manifest.id, true, { authorize, expectedRevision: store.snapshot().revision })
    expect((await store.migrateLegacySeeds({ client, authorize })).snapshot.plugins[0]).toMatchObject({ selectedDigest: newer.digest, pinned: true })
    await expect(store.stageSeed(first.manifest.id, stageOptions)).rejects.toMatchObject({ code: "NEWER_INSTALLED" })
  })
  it("allows authenticated TUF updates after seed import and retains offline seed rollback", async () => {
    let store = await open()
    await store.migrateLegacySeeds({ client, authorize })
    await store.close(); store = await open({ officialRoots: new Map([["cogpit", createRoot(authority)]]) })
    const newer = signedPackage(authority, { publisher: "cogpit", id: "cogpit.clickup", version: "1.1.0", retained: [first] })
    await install(store, newer)
    const preview = await store.rollback(first.manifest.id, first.digest, stageOptions)
    await store.payload(preview.transactionId, owner); await store.beginTrial(preview.transactionId, owner, { authorize })
    await store.commit(preview.transactionId, owner, { authorize, expectedRevision: preview.registryRevision })
    expect(store.snapshot().plugins[0].selectedDigest).toBe(first.digest)
  })
  it("retained TUF target revocation blocks seeds even after a new app release", async () => {
    let store = await open()
    await store.migrateLegacySeeds({ client, authorize })
    await store.close(); store = await open({ officialRoots: new Map([["cogpit", createRoot(authority)]]) })
    const newer = signedPackage(authority, { publisher: "cogpit", id: "cogpit.clickup", version: "1.1.0" })
    await store.stage(newer.bytes, stageOptions)
    expect(store.snapshot().plugins[0]).toMatchObject({ enabled: false })
    await expect(store.setEnabled(first.manifest.id, true, { authorize, expectedRevision: store.snapshot().revision })).rejects.toMatchObject({ code: "REVOKED" })
    await expect(store.stageSeed(first.manifest.id, stageOptions)).rejects.toMatchObject({ code: "UNTRUSTED_PACKAGE" })
    await store.close(); store = await open({ appSeeds: [seed(first, "2.9.0")] })
    await expect(store.stageSeed(first.manifest.id, stageOptions)).rejects.toMatchObject({ code: "UNTRUSTED_PACKAGE" })
  })
  it("retained newer metadata blocks an uninstalled seed target absent from that metadata", async () => {
    const store = await open({ officialRoots: new Map([["cogpit", createRoot(authority)]]) })
    await store.stage(signedPackage(authority, { publisher: "cogpit", id: "cogpit.clickup", version: "1.1.0" }).bytes, stageOptions)
    await expect(store.stageSeed(first.manifest.id, stageOptions)).rejects.toMatchObject({ code: "UNTRUSTED_PACKAGE" })
  })
  it("enforces compatibility and schema checks without committing a migration decision on failure", async () => {
    const store = await open({ host: { ...host, apiVersions: ["2.0.0"] } })
    expect(await store.migrateLegacySeeds({ client, authorize })).toMatchObject({ snapshot: { plugins: [] }, failures: [{ id: first.manifest.id, code: "INCOMPATIBLE" }] })
    const registry = JSON.parse(await readFile(join(root, "registry.json"), "utf8"))
    expect(registry.seedMigration.decisions).toEqual({})
    const invalid = seed(); invalid.payload = Buffer.from('{"archiveVersion":1,"files":[]}')
    invalid.payloadDigest = createHash("sha256").update(invalid.payload).digest("hex")
    expect(() => captureAppSeeds([invalid])).toThrow()
  })
  it("rejects release digest mismatches, namespace mismatches, duplicates and mutable catalog inputs", async () => {
    expect(() => captureAppSeeds([{ ...seed(), payloadDigest: "0".repeat(64) }])).toThrow("digest")
    expect(() => captureAppSeeds([{ ...seed(), id: "cogpit.other" }])).toThrow("identity")
    expect(() => captureAppSeeds([seed(), seed()])).toThrow("duplicate")
    const entry = seed(), payload = Buffer.from(entry.payload)
    entry.payload = payload
    const store = await open({ appSeeds: [entry] })
    payload.fill(0); entry.payloadDigest = "0".repeat(64); entry.targetPath = "wrong.json"
    expect((await store.migrateLegacySeeds({ client, authorize })).snapshot.plugins[0].selectedDigest).toBe(first.digest)
  })
  it("applies the ordinary immutable package quota before importing seeds", async () => {
    const store = await open()
    await Promise.all(Array.from({ length: 256 }, (_, index) => writeFile(join(root, "packages", `${index.toString(16).padStart(64, "0")}.json`), "")))
    expect(await store.migrateLegacySeeds({ client, authorize })).toMatchObject({ snapshot: { plugins: [] }, failures: [{ id: first.manifest.id, code: "QUOTA_EXCEEDED" }] })
    expect(JSON.parse(await readFile(join(root, "registry.json"), "utf8")).seedMigration.decisions).toEqual({})
  })
  it("available seed snapshots do not expose bytes or mutate the trusted catalog", async () => {
    const store = await open()
    const available = store.snapshot().availableSeeds!
    expect(available).toEqual([{ manifest: first.manifest, digest: first.digest }])
    available[0].manifest.name = "Mutated UI copy"
    const preview = await store.stageSeed(first.manifest.id, stageOptions)
    expect(preview.manifest.name).toBe(first.manifest.name)
  })
  it("requires pre-setup classification and refuses indeterminate automatic imports", async () => {
    let store = await open({ legacyHost: undefined })
    await expect(store.migrateLegacySeeds({ client, authorize })).rejects.toMatchObject({ code: "HOST_CLASSIFICATION_REQUIRED" })
    await store.close(); store = await open({ legacyHost: { ...legacy, classification: "indeterminate", evidence: "invalid-config" } })
    await expect(store.migrateLegacySeeds({ client, authorize })).rejects.toMatchObject({ code: "HOST_CLASSIFICATION_UNKNOWN" })
    expect(store.snapshot().plugins).toEqual([])
  })
  it("reauthorizes automatic promotion and preserves mutation drain hooks", async () => {
    let allowed = true, after = 0
    const store = await open({ beforeChange: () => { allowed = false }, afterMutation: () => { after++ } })
    await expect(store.migrateLegacySeeds({ client, authorize: () => { if (!allowed) throw new Error("revoked") } })).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(store.snapshot().plugins).toEqual([])
    expect(after).toBeGreaterThanOrEqual(2)
  })
})

describe("seed transaction crash recovery", () => {
  it("retains an uninstall tombstone when the host stops after the registry rename", async () => {
    let crash = false
    const store = await open({ crashHook: step => { if (crash && step === "uninstall-registry:renamed") throw new Error("interrupted uninstall") } })
    await store.migrateLegacySeeds({ client, authorize }); crash = true
    await expect(store.uninstall(first.manifest.id, { authorize, expectedRevision: store.snapshot().revision })).rejects.toThrow("interrupted uninstall")
    await store.close()
    const restarted = await open()
    expect((await restarted.migrateLegacySeeds({ client, authorize })).snapshot.plugins).toEqual([])
    expect(restarted.snapshot().legacyPluginIds).not.toContain("clickup")
  })

  it.each(["app-seed-trust:renamed", "package:renamed", "prepared-seed:renamed", "commit-intent:renamed", "commit-registry:renamed", "committed:renamed"])("recovers at %s without duplicate installs or losing uninstall tombstones", async (stop) => {
    const store = await open({ crashHook: step => { if (step === stop) throw new Error("simulated interruption") } })
    await expect(store.migrateLegacySeeds({ client, authorize })).rejects.toThrow("simulated interruption")
    await store.close()
    const recovered = await open()
    expect(recovered.snapshot().available).toBe(true)
    expect((await recovered.migrateLegacySeeds({ client, authorize })).failures).toEqual([])
    expect(recovered.snapshot().plugins).toHaveLength(1)
    const decisions = JSON.parse(await readFile(join(root, "registry.json"), "utf8")).seedMigration.decisions
    expect(decisions["cogpit.clickup"]).toBe("imported")
    await recovered.uninstall(first.manifest.id, { authorize, expectedRevision: recovered.snapshot().revision })
    expect((await recovered.migrateLegacySeeds({ client, authorize })).snapshot.plugins).toEqual([])
  })
})
