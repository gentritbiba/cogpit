// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, readFile, readdir, rm, writeFile, utimes, mkdir, symlink, readlink, truncate } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseConnectionDefinition } from "@cogpit/plugin-contracts"
import { MAX_RETAINED_VERSIONS, openPluginStore, type PluginStore, type PluginStoreOptions } from "../../plugins/store"
import { createAuthority, createRoot, type Authority } from "./fixtures/signing"
import { authorize, client, host, owner, signedPackage, type SignedPackage } from "./fixtures/storeSigning"

let directory: string
let root: string
let store: PluginStore
let authority: Authority
let options: PluginStoreOptions
const opened: PluginStore[] = []
async function open(overrides: Partial<PluginStoreOptions> = {}) {
  const result = await openPluginStore(root, { ...options, ...overrides }); opened.push(result); return result
}
const stageOptions = () => ({ owner, client, scope: { type: "projects" as const, projectIds: [`p_${"1".repeat(40)}`] }, authorize })
async function install(candidate: SignedPackage) {
  const preview = await store.stage(candidate.bytes, stageOptions())
  await store.payload(preview.transactionId, owner)
  await store.beginTrial(preview.transactionId, owner, { authorize })
  await store.commit(preview.transactionId, owner, { authorize, expectedRevision: preview.registryRevision })
  return preview
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cogpit-plugin-store-test-")); root = join(directory, "plugins")
  authority = createAuthority(); options = { host }
  store = await open()
  expect(store.snapshot().available).toBe(true)
  await store.enrollDeveloper("dev-test", "Fixture developer", createRoot(authority), { authorize })
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const instance of opened.splice(0)) await instance.close()
  await rm(directory, { recursive: true, force: true })
})

describe("durable host plugin store", () => {
  it("previews verified connection declarations for installation and rollback", async () => {
    const operation = { origin: "https://api.example.com", method: "GET", path: [{ literal: "items" }], args: {}, query: {} }
    const definition = parseConnectionDefinition({ version: 1, id: "catalog", label: "Catalog", secret: { id: "token", label: "Token" }, auth: { header: "Authorization", scheme: "bearer" }, validationOperation: "validate", resources: { item: { label: "Item", options: { operation: "validate", items: "/items", id: "/id", label: "/name" } } }, operations: { validate: { ...operation, audience: "setup" }, read: { ...operation, audience: "panel" } } })
    const first = signedPackage(authority, { connection: definition })
    const preview = await install(first)
    expect(preview.operation).toBe("install")
    expect(preview.previousManifest).toBeUndefined()
    expect(preview.connectionDefinitions).toEqual([definition])
    preview.connectionDefinitions[0].label = "Mutated client copy"
    expect((await store.transactionOutcome(preview.transactionId, owner)).preview.connectionDefinitions).toEqual([definition])
    const update = await install(signedPackage(authority, { version: "1.1.0", metadataVersion: 2, retained: [first] }))
    expect(update).toMatchObject({ operation: "update", previousManifest: first.manifest, previousConnectionDefinitions: [definition] })
    const rollback = await store.rollback(first.manifest.id, first.digest, stageOptions())
    expect(rollback.connectionDefinitions).toEqual([definition])
    expect(rollback).toMatchObject({ operation: "rollback", previousManifest: update.manifest, previousConnectionDefinitions: [] })
  })

  it("installs exact bytes, persists over restart, and exposes no private paths", async () => {
    const candidate = signedPackage(authority)
    const preview = await install(candidate)
    expect(store.snapshot().plugins[0]).toMatchObject({ selectedDigest: candidate.digest, enabled: true, scope: stageOptions().scope })
    expect(JSON.stringify(store.snapshot())).not.toContain(directory)
    expect(await store.payload(candidate.digest)).toEqual(candidate.payload)
    await store.close(); store = await open()
    expect(store.snapshot()).toMatchObject({ available: true, revision: 1, plugins: [{ selectedDigest: candidate.digest }] })
    expect(await store.transactionOutcome(preview.transactionId, owner)).toMatchObject({ status: "committed", preview: { digest: candidate.digest } })
  })

  it("does not activate a candidate before commit and requires its bytes before trial", async () => {
    const preview = await store.stage(signedPackage(authority).bytes, stageOptions())
    expect(store.snapshot().plugins).toEqual([])
    await expect(store.beginTrial(preview.transactionId, owner, { authorize })).rejects.toMatchObject({ code: "PAYLOAD_REQUIRED" })
    await store.payload(preview.transactionId, owner)
    const beforeTrial = Date.now()
    const trial = await store.beginTrial(preview.transactionId, owner, { authorize })
    expect(trial.deadline).toBeGreaterThanOrEqual(beforeTrial + 30000)
    expect(trial.deadline).toBeLessThanOrEqual(Date.now() + 30000)
    expect(store.snapshot().plugins).toEqual([])
    await expect(store.payload(preview.digest)).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("binds all candidate access to its opaque owner and makes retries idempotent", async () => {
    const candidate = signedPackage(authority)
    const input = { ...stageOptions(), idempotencyKey: "install-1" }
    const first = await store.stage(candidate.bytes, input)
    expect(await store.stage(candidate.bytes, input)).toEqual(first)
    await expect(store.payload(first.transactionId, "another-owner")).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(store.transactionOutcome(first.transactionId, "another-owner")).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(store.stage(signedPackage(authority, { metadataVersion: 2 }).bytes, input)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" })
    await store.cancel(first.transactionId, owner, { authorize })
    await expect(store.payload(first.transactionId, owner)).rejects.toMatchObject({ code: "TRANSACTION_FINISHED" })
  })

  it("keeps owner and idempotency-key boundaries unambiguous", async () => {
    const candidate = signedPackage(authority)
    const first = await store.stage(candidate.bytes, { ...stageOptions(), owner: "first\0second", idempotencyKey: "third" })
    const second = await store.stage(candidate.bytes, { ...stageOptions(), owner: "first", idempotencyKey: "second\0third" })
    expect(first.transactionId).not.toBe(second.transactionId)
  })

  it("rejects stale review, owner mismatch, and expired trials", async () => {
    const candidate = signedPackage(authority)
    await install(candidate)
    const preview = await store.stage(candidate.bytes, stageOptions())
    await store.payload(preview.transactionId, owner)
    const { deadline } = await store.beginTrial(preview.transactionId, owner, { authorize })
    await expect(store.commit(preview.transactionId, "another-owner", { authorize, expectedRevision: preview.registryRevision })).rejects.toMatchObject({ code: "NOT_FOUND" })
    vi.spyOn(Date, "now").mockReturnValue(deadline + 1)
    await expect(store.commit(preview.transactionId, owner, { authorize, expectedRevision: preview.registryRevision })).rejects.toMatchObject({ code: "TRIAL_EXPIRED" })
    vi.restoreAllMocks()
    await store.setEnabled(candidate.manifest.id, false, { authorize, expectedRevision: preview.registryRevision })
    await expect(store.commit(preview.transactionId, owner, { authorize, expectedRevision: preview.registryRevision })).rejects.toMatchObject({ code: "STALE_REVISION" })
  })

  it("reauthorizes enrollment after validation and commit after revoking old leases", async () => {
    let enrollmentCalls = 0
    await expect(store.enrollDeveloper("dev-other", "Other", createRoot(createAuthority()), { authorize: async () => { if (++enrollmentCalls === 2) throw new Error("logged out") } })).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(store.snapshot().publishers).toHaveLength(1)
    const candidate = signedPackage(authority)
    const preview = await store.stage(candidate.bytes, stageOptions())
    await store.payload(preview.transactionId, owner)
    await store.beginTrial(preview.transactionId, owner, { authorize })
    let allowed = true
    await store.close()
    store = await open({ beforeChange: async () => { allowed = false } })
    const replacement = await store.stage(candidate.bytes, stageOptions())
    await store.payload(replacement.transactionId, owner); await store.beginTrial(replacement.transactionId, owner, { authorize })
    await expect(store.commit(replacement.transactionId, owner, { expectedRevision: replacement.registryRevision, authorize: async () => { if (!allowed) throw new Error("logged out") } })).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(store.snapshot()).toMatchObject({ available: true, revision: 0, plugins: [] })
  })

  it("supports disable, scope, pin, rollback and uninstall while retaining schema and trust", async () => {
    const first = signedPackage(authority)
    await install(first)
    const second = signedPackage(authority, { version: "1.1.0", metadataVersion: 2, retained: [first] })
    await install(second)
    let revision = store.snapshot().revision
    await store.setEnabled(first.manifest.id, false, { authorize, expectedRevision: revision++ })
    await store.setScope(first.manifest.id, { type: "all" }, { authorize, expectedRevision: revision++ })
    await store.setPin(first.manifest.id, true, { authorize, expectedRevision: revision++ })
    await expect(store.rollback(first.manifest.id, first.digest, stageOptions())).rejects.toMatchObject({ code: "PINNED" })
    await store.setPin(first.manifest.id, false, { authorize, expectedRevision: revision++ })
    const rollback = await store.rollback(first.manifest.id, first.digest, stageOptions())
    await store.payload(rollback.transactionId, owner); await store.beginTrial(rollback.transactionId, owner, { authorize })
    await store.commit(rollback.transactionId, owner, { authorize, expectedRevision: revision++ })
    expect(store.snapshot().plugins[0].selectedDigest).toBe(first.digest)
    await store.uninstall(first.manifest.id, { authorize, expectedRevision: revision })
    expect(store.snapshot().plugins).toEqual([])
    await expect(store.payload(first.digest)).rejects.toMatchObject({ code: "NOT_FOUND" })
    const registry = JSON.parse(await readFile(join(root, "registry.json"), "utf8"))
    expect(registry.dataSchemas[first.manifest.id]).toEqual([1])
    const incompatible = signedPackage(authority, { version: "2.0.0", stateVersion: 2, metadataVersion: 3, retained: [first, second] })
    await expect(store.stage(incompatible.bytes, stageOptions())).rejects.toMatchObject({ code: "STATE_VERSION" })
    expect(JSON.parse(await readFile(join(root, "trust.json"), "utf8")).publishers["dev-test"].checkpoint.verifiedAt).toBeGreaterThan(0)
  })

  it("retains authenticated trust when candidate payload fails and rejects replay after restart", async () => {
    const original = signedPackage(authority)
    await install(original)
    const newer = signedPackage(authority, { version: "1.1.0", metadataVersion: 2, retained: [original] })
    const value = JSON.parse(newer.bytes.toString()); value.payload = Buffer.from("bad payload").toString("base64")
    await expect(store.stage(Buffer.from(JSON.stringify(value)), stageOptions())).rejects.toMatchObject({ code: "UNTRUSTED_PACKAGE" })
    await store.close(); store = await open()
    await expect(store.stage(original.bytes, stageOptions())).rejects.toMatchObject({ code: "UNTRUSTED_PACKAGE" })
    expect(store.snapshot().plugins[0]).toMatchObject({ selectedDigest: original.digest, enabled: true })
  })

  it("audits installed targets when a staged bundle carries newer revocation metadata", async () => {
    const original = signedPackage(authority)
    await install(original)
    const changed = signedPackage(authority, { version: "1.1.0", metadataVersion: 2 })
    await store.stage(changed.bytes, stageOptions())
    expect(store.snapshot().plugins[0]).toMatchObject({ selectedDigest: original.digest, enabled: false, lastError: "The selected package was revoked" })
    await expect(store.setEnabled(original.manifest.id, true, { authorize, expectedRevision: store.snapshot().revision })).rejects.toMatchObject({ code: "REVOKED" })
    await store.close(); store = await open()
    expect(store.snapshot().plugins[0].enabled).toBe(false)
  })

  it("audits and reuses a bundle after its supplied root rotation was already accepted", async () => {
    const original = signedPackage(authority); await install(original)
    const replacement = createAuthority()
    const nextRoot = createRoot(replacement, { version: 2, previous: authority })
    const candidate = signedPackage(replacement, { version: "1.1.0", metadataVersion: 2, retained: [original] })
    const envelope = JSON.parse(candidate.bytes.toString()); envelope.roots = [nextRoot.toString("utf8")]
    candidate.bytes = Buffer.from(JSON.stringify(envelope))
    await install(candidate)
    expect(store.snapshot().plugins[0]).toMatchObject({ selectedDigest: candidate.digest, enabled: true })
    expect((await store.stage(candidate.bytes, stageOptions())).digest).toBe(candidate.digest)
  })

  it("reauthorizes immediately before the atomic registry rename", async () => {
    await store.close()
    let allowed = true
    store = await open({ crashHook: step => { if (step === "commit-registry:file-synced") allowed = false } })
    const preview = await store.stage(signedPackage(authority).bytes, stageOptions())
    await store.payload(preview.transactionId, owner); await store.beginTrial(preview.transactionId, owner, { authorize })
    await expect(store.commit(preview.transactionId, owner, { expectedRevision: preview.registryRevision, authorize: async () => { if (!allowed) throw new Error("revoked") } })).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(store.snapshot()).toMatchObject({ available: true, revision: 0, plugins: [] })
    await store.close(); store = await open()
    expect(store.snapshot()).toMatchObject({ available: true, revision: 0, plugins: [] })
  })

  it("rechecks the trial deadline immediately before the atomic registry rename", async () => {
    await store.close()
    let expired = 0
    store = await open({ crashHook: step => { if (step === "commit-registry:file-synced") vi.spyOn(Date, "now").mockReturnValue(expired) } })
    const preview = await store.stage(signedPackage(authority).bytes, stageOptions())
    await store.payload(preview.transactionId, owner)
    expired = (await store.beginTrial(preview.transactionId, owner, { authorize })).deadline + 1
    await expect(store.commit(preview.transactionId, owner, { authorize, expectedRevision: preview.registryRevision })).rejects.toMatchObject({ code: "TRIAL_EXPIRED" })
    expect(store.snapshot()).toMatchObject({ available: true, revision: 0, plugins: [] })
  })

  it("supports an explicitly pinned publisher whose name is an inherited object property", async () => {
    await store.close()
    store = await open({ officialRoots: new Map([["constructor", createRoot(authority)]]) })
    await install(signedPackage(authority, { publisher: "constructor" }))
    expect(store.snapshot().plugins[0].manifest.publisher).toBe("constructor")
  })

  it("does not repair missing retained publisher trust from a newly supplied official root", async () => {
    const roots = new Map([["official", createRoot(authority)]])
    await store.close(); store = await open({ officialRoots: roots })
    await install(signedPackage(authority, { publisher: "official" }))
    await store.close()
    const path = join(root, "trust.json")
    const trust = JSON.parse(await readFile(path, "utf8")); delete trust.publishers.official
    const corrupt = Buffer.from(JSON.stringify(trust)); await writeFile(path, corrupt)
    store = await open({ officialRoots: roots })
    expect(store.snapshot()).toMatchObject({ available: false, error: "Plugin publisher trust record is missing" })
    expect(await readFile(path)).toEqual(corrupt)
  })

  it("rechecks metadata expiry at commit rather than trusting an earlier preview", async () => {
    const preview = await store.stage(signedPackage(authority).bytes, stageOptions())
    await store.payload(preview.transactionId, owner)
    const later = Date.now() + 2 * 86400_000
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(later)
    await store.beginTrial(preview.transactionId, owner, { authorize })
    await expect(store.commit(preview.transactionId, owner, { authorize, expectedRevision: preview.registryRevision })).rejects.toMatchObject({ code: "UNTRUSTED_PACKAGE" })
    expect(store.snapshot().plugins).toEqual([])
  })

  it("removes cancelled unreferenced package bytes while retaining trust", async () => {
    const preview = await store.stage(signedPackage(authority).bytes, stageOptions())
    await store.cancel(preview.transactionId, owner, { authorize })
    await expect(readFile(join(root, "packages", `${preview.digest}.json`))).rejects.toMatchObject({ code: "ENOENT" })
    expect(JSON.parse(await readFile(join(root, "trust.json"), "utf8")).publishers["dev-test"].checkpoint.verifiedTargets).not.toEqual({})
  })

  it("recovers retained revocation before exposing plugins after a trust-write crash", async () => {
    const original = signedPackage(authority); await install(original); await store.close()
    let armed = false
    store = await open({ crashHook: step => { if (armed && step === "trust:renamed") throw new Error("simulated crash") } })
    armed = true
    await expect(store.stage(signedPackage(authority, { version: "1.1.0", metadataVersion: 2 }).bytes, stageOptions())).rejects.toThrow("simulated crash")
    await store.close(); store = await open()
    expect(store.snapshot()).toMatchObject({ available: true, plugins: [{ enabled: false, selectedDigest: original.digest }] })
  })

  it.each(["constructor", "toString", "__proto__"])("rejects inherited publisher and plugin record name %s without disabling the store", async name => {
    const candidate = signedPackage(authority)
    const envelope = JSON.parse(candidate.bytes.toString()); envelope.publisher = name
    await expect(store.stage(Buffer.from(JSON.stringify(envelope)), stageOptions())).rejects.toMatchObject({ code: "UNKNOWN_PUBLISHER" })
    await expect(store.setEnabled(name, true, { authorize, expectedRevision: 0 })).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(store.rollback(name, candidate.digest, stageOptions())).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect(store.snapshot().available).toBe(true)
  })

  it("rejects malformed uploaded roots without disabling management", async () => {
    const candidate = signedPackage(authority)
    const envelope = JSON.parse(candidate.bytes.toString()); envelope.roots = ['{"signed":{"_type":"targets"}}']
    await expect(store.stage(Buffer.from(JSON.stringify(envelope)), stageOptions())).rejects.toMatchObject({ code: "INVALID_PACKAGE" })
    expect(store.snapshot().available).toBe(true)
  })

  it("rejects non-development enrollment and immutable ID/version substitution", async () => {
    await expect(store.enrollDeveloper("cogpit", "Impersonator", createRoot(authority), { authorize })).rejects.toMatchObject({ code: "INVALID_PUBLISHER" })
    const original = signedPackage(authority); await install(original)
    const substituted = signedPackage(authority, { metadataVersion: 2, script: "changed", targetSuffix: "different", retained: [original] })
    await expect(store.stage(substituted.bytes, stageOptions())).rejects.toMatchObject({ code: "IMMUTABLE_VERSION" })
  })

  it.each(["registry.json", "trust.json"])("preserves corrupt %s and disables the subsystem", async filename => {
    await store.close()
    const corrupted = Buffer.from('{"broken":')
    await writeFile(join(root, filename), corrupted)
    store = await open()
    expect(store.snapshot().available).toBe(false)
    expect(await readFile(join(root, filename))).toEqual(corrupted)
  })

  it.each(["registry.json", "trust.json"])("refuses future %s without rewriting it", async filename => {
    await store.close()
    const value = JSON.parse(await readFile(join(root, filename), "utf8")); value.formatVersion = 2; value.minWriterVersion = 2
    const future = Buffer.from(JSON.stringify(value)); await writeFile(join(root, filename), future)
    store = await open()
    expect(store.snapshot().available).toBe(false)
    expect(await readFile(join(root, filename))).toEqual(future)
  })

  it("refuses future journals before modifying persistent registry or trust", async () => {
    const preview = await store.stage(signedPackage(authority).bytes, stageOptions())
    await store.close()
    const path = join(root, "transactions", `${preview.transactionId}.json`)
    const value = JSON.parse(await readFile(path, "utf8")); value.minWriterVersion = 2
    await writeFile(path, JSON.stringify(value))
    const registry = await readFile(join(root, "registry.json")); const trust = await readFile(join(root, "trust.json"))
    store = await open({ officialRoots: new Map([["official", createRoot(createAuthority())]]) })
    expect(store.snapshot().available).toBe(false)
    expect(await readFile(join(root, "registry.json"))).toEqual(registry)
    expect(await readFile(join(root, "trust.json"))).toEqual(trust)
  })

  it("quarantines changed package bytes while keeping registry and trust usable", async () => {
    const candidate = signedPackage(authority); await install(candidate); await store.close()
    await writeFile(join(root, "packages", `${candidate.digest}.json`), "corrupt")
    store = await open()
    expect(store.snapshot()).toMatchObject({ available: true, plugins: [{ enabled: false, versions: [{ unavailableReason: expect.stringContaining("missing or corrupt") }] }] })
    await expect(store.payload(candidate.digest)).rejects.toMatchObject({ code: "PACKAGE_UNAVAILABLE" })
    await expect(store.setEnabled(candidate.manifest.id, true, { expectedRevision: store.snapshot().revision, authorize })).rejects.toMatchObject({ code: "PACKAGE_UNAVAILABLE" })
    expect(await readFile(join(root, "packages", `${candidate.digest}.json`), "utf8")).toBe("corrupt")
    const trust = await readFile(join(root, "trust.json"))
    await store.uninstall(candidate.manifest.id, { expectedRevision: store.snapshot().revision, authorize })
    expect(store.snapshot()).toMatchObject({ available: true, plugins: [] })
    expect(await readFile(join(root, "trust.json"))).toEqual(trust)
  })

  it("isolates a corrupt selected package and can roll back to intact retained bytes", async () => {
    const first = signedPackage(authority); await install(first)
    const second = signedPackage(authority, { version: "1.1.0", metadataVersion: 2, retained: [first] }); await install(second)
    const unrelated = signedPackage(authority, { id: "dev-test.other", metadataVersion: 3, retained: [first, second] }); await install(unrelated)
    await store.close()
    await writeFile(join(root, "packages", `${second.digest}.json`), "damaged")
    store = await open()
    expect(store.snapshot().plugins.find(plugin => plugin.id === unrelated.manifest.id)?.enabled).toBe(true)
    expect(await store.payload(unrelated.digest)).toEqual(unrelated.payload)
    const preview = await store.rollback(first.manifest.id, first.digest, stageOptions())
    await store.payload(preview.transactionId, owner); await store.beginTrial(preview.transactionId, owner, { authorize })
    await store.commit(preview.transactionId, owner, { expectedRevision: preview.registryRevision, authorize })
    await store.setEnabled(first.manifest.id, true, { expectedRevision: store.snapshot().revision, authorize })
    expect(store.snapshot().plugins.find(plugin => plugin.id === first.manifest.id)).toMatchObject({ selectedDigest: first.digest, enabled: true })
  })

  it("preserves a quarantined symlink without following it or blocking another install", async () => {
    const first = signedPackage(authority); await install(first); await store.close()
    const packagePath = join(root, "packages", `${first.digest}.json`), outside = join(directory, "outside")
    await writeFile(outside, "private outside bytes"); await rm(packagePath); await symlink(outside, packagePath)
    store = await open()
    expect(store.snapshot().available).toBe(true)
    await install(signedPackage(authority, { id: "dev-test.other", metadataVersion: 2, retained: [first] }))
    expect(await readlink(packagePath)).toBe(outside)
    expect(await readFile(outside, "utf8")).toBe("private outside bytes")
  })

  it("repairs a quarantined exact version only from verified bytes and preserves the damaged entry", async () => {
    const candidate = signedPackage(authority); await install(candidate)
    const path = join(root, "packages", `${candidate.digest}.json`)
    await writeFile(path, "original damage")
    await expect(store.payload(candidate.digest)).rejects.toMatchObject({ code: "PACKAGE_UNAVAILABLE" })
    const tampered = JSON.parse(candidate.bytes.toString()); tampered.payload = Buffer.from("invalid").toString("base64")
    await expect(store.stage(Buffer.from(JSON.stringify(tampered)), stageOptions())).rejects.toThrow()
    expect(await readdir(join(root, "quarantine"))).toEqual([])
    const preview = await store.stage(candidate.bytes, stageOptions())
    expect(await store.payload(candidate.digest)).toEqual(candidate.payload)
    expect(store.snapshot().plugins[0]).toMatchObject({ enabled: false, selectedDigest: candidate.digest })
    expect(store.snapshot().plugins[0].versions[0].unavailableReason).toBeUndefined()
    const [backup] = await readdir(join(root, "quarantine"))
    expect(await readFile(join(root, "quarantine", backup), "utf8")).toBe("original damage")
    await store.cancel(preview.transactionId, owner, { authorize })
    expect(store.snapshot().plugins[0].enabled).toBe(false)
    await store.setEnabled(candidate.manifest.id, true, { expectedRevision: store.snapshot().revision, authorize })
    expect(store.snapshot().plugins[0].enabled).toBe(true)
    expect(store.snapshot().plugins[0].lastError).toBeUndefined()
  })

  it("moves a corrupt symlink into quarantine during verified repair without touching its target", async () => {
    const candidate = signedPackage(authority); await install(candidate)
    const path = join(root, "packages", `${candidate.digest}.json`), outside = join(directory, "external")
    await writeFile(outside, "outside"); await rm(path); await symlink(outside, path)
    await expect(store.payload(candidate.digest)).rejects.toMatchObject({ code: "PACKAGE_UNAVAILABLE" })
    await store.stage(candidate.bytes, stageOptions())
    const [backup] = await readdir(join(root, "quarantine"))
    expect(await readlink(join(root, "quarantine", backup))).toBe(outside)
    expect(await readFile(outside, "utf8")).toBe("outside")
    expect(await store.payload(candidate.digest)).toEqual(candidate.payload)
  })

  it.each(["count", "bytes"])("includes quarantine %s in the package retention quota", async limit => {
    const candidate = signedPackage(authority); await install(candidate)
    await writeFile(join(root, "packages", `${candidate.digest}.json`), "damage")
    await expect(store.payload(candidate.digest)).rejects.toMatchObject({ code: "PACKAGE_UNAVAILABLE" })
    if (limit === "count") await Promise.all(Array.from({ length: 255 }, (_, index) => writeFile(join(root, "quarantine", `retained-${index}`), "x")))
    else { const path = join(root, "quarantine", "retained"); await writeFile(path, ""); await truncate(path, 256 * 1024 * 1024) }
    await expect(store.stage(candidate.bytes, stageOptions())).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" })
    expect(store.snapshot().available).toBe(true)
    await expect(store.payload(candidate.digest)).rejects.toMatchObject({ code: "PACKAGE_UNAVAILABLE" })
  })

  it("rolls back exact retained verified bytes after metadata expires, including after restart", async () => {
    const first = signedPackage(authority); await install(first)
    const second = signedPackage(authority, { version: "1.1.0", metadataVersion: 2, retained: [first] }); await install(second)
    await store.close()
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 2 * 86400_000)
    store = await open()
    const preview = await store.rollback(first.manifest.id, first.digest, stageOptions())
    await store.payload(preview.transactionId, owner); await store.beginTrial(preview.transactionId, owner, { authorize })
    await store.commit(preview.transactionId, owner, { expectedRevision: preview.registryRevision, authorize })
    expect(store.snapshot().plugins[0].selectedDigest).toBe(first.digest)
    await expect(store.stage(second.bytes, stageOptions())).rejects.toMatchObject({ code: "UNTRUSTED_PACKAGE" })
  })

  it("audits revocation of inactive retained versions and keeps it sticky after expiry", async () => {
    const first = signedPackage(authority); await install(first)
    const second = signedPackage(authority, { version: "1.1.0", metadataVersion: 2, retained: [first] }); await install(second)
    const update = signedPackage(authority, { version: "1.2.0", metadataVersion: 3, retained: [second] })
    const preview = await store.stage(update.bytes, stageOptions()); await store.cancel(preview.transactionId, owner, { authorize })
    expect(store.snapshot().plugins[0]).toMatchObject({ enabled: true, selectedDigest: second.digest })
    await store.close(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 2 * 86400_000); store = await open()
    await expect(store.rollback(first.manifest.id, first.digest, stageOptions())).rejects.toMatchObject({ code: "REVOKED" })
    expect(store.snapshot().plugins[0].enabled).toBe(true)
  })

  it("bounds retained versions while preserving the selected predecessor and immutable identities", async () => {
    const packages: SignedPackage[] = []
    for (let index = 0; index < MAX_RETAINED_VERSIONS + 2; index++) {
      const candidate = signedPackage(authority, { version: `1.${index}.0`, metadataVersion: index + 1, retained: packages })
      await install(candidate); packages.push(candidate)
    }
    const plugin = store.snapshot().plugins[0]
    expect(plugin.versions).toHaveLength(MAX_RETAINED_VERSIONS)
    expect(plugin.versions.map(version => version.digest)).toEqual(packages.slice(2).map(candidate => candidate.digest))
    await expect(store.rollback(plugin.id, packages[0].digest, stageOptions())).rejects.toMatchObject({ code: "NOT_FOUND" })
    const registry = JSON.parse(await readFile(join(root, "registry.json"), "utf8"))
    expect(registry.identities[`${plugin.id}@1.0.0`]).toBe(packages[0].digest)
    const older = signedPackage(authority, { version: "1.0.0", metadataVersion: packages.length + 1, retained: packages })
    await expect(store.stage(older.bytes, stageOptions())).rejects.toMatchObject({ code: "DOWNGRADE" })
  }, 30000)

  it("keeps a live same-host owner even when its heartbeat looks stale", async () => {
    const old = new Date(Date.now() - 60000)
    await utimes(join(root, ".store.lock"), old, old)
    const second = await open()
    expect(second.snapshot()).toMatchObject({ available: false, error: expect.stringContaining("live owner") })
    expect(store.snapshot().available).toBe(true)
  })

  it("refuses automatic takeover if an existing lock has no owner record", async () => {
    await store.close()
    await mkdir(join(root, ".store.lock"))
    const old = new Date(Date.now() - 60000); await utimes(join(root, ".store.lock"), old, old)
    const second = await open()
    expect(second.snapshot()).toMatchObject({ available: false, error: expect.stringContaining("missing or malformed ownership") })
  })

  it("checks ownership again before durable mutations and invokes compromise revocation", async () => {
    await store.close()
    const compromised = vi.fn(); store = await open({ onCompromised: compromised })
    const path = join(root, "owner.json"); const ownerRecord = JSON.parse(await readFile(path, "utf8")); ownerRecord.token = "00000000-0000-4000-8000-000000000000"
    await writeFile(path, JSON.stringify(ownerRecord))
    await expect(store.stage(signedPackage(authority).bytes, stageOptions())).rejects.toThrow("owner changed")
    expect(store.snapshot().available).toBe(false)
    expect(compromised).toHaveBeenCalled()
  })
})
