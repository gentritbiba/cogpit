// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createArchive, createPublisher, rootFingerprint, signBundle } from "@cogpit/plugin-tools"
import { appSeedClientDescriptor, loadAppPluginSeeds } from "../../plugins/appSeeds"
import { captureLegacyPluginHost } from "../../plugins/legacyHost"
import { openPluginStore, type PluginStore } from "../../plugins/store"
import { pluginRuntimeDescriptor } from "../../plugins/runtime"
import { authorize, owner } from "./fixtures/storeSigning"

const root = join(process.cwd(), "generated", "runtime-plugins", "cloudflare")
const client = appSeedClientDescriptor()
let directory: string
let store: PluginStore
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cogpit-plugin-tools-install-"))
  store = await openPluginStore(join(directory, "runtime-plugins"), { host: pluginRuntimeDescriptor(), appSeeds: loadAppPluginSeeds(), legacyHost: await captureLegacyPluginHost(directory) })
})
afterEach(async () => { await store.close(); await rm(directory, { recursive: true, force: true }) })

describe("packages signed with cogpit-plugin", () => {
  it("install through developer enrollment, update as a later metadata version and roll back to the retained one", async () => {
    let publisher = createPublisher("dev-qa")
    const first = signBundle(publisher, await createArchive(root, { publisher: "dev-qa", version: "1.0.0-dev.1" }))
    publisher = first.publisher
    await expect(store.stage(first.bytes, { owner, client, scope: { type: "all" }, authorize })).rejects.toMatchObject({ code: "UNKNOWN_PUBLISHER" })
    await store.enrollDeveloper("dev-qa", "QA publisher", Buffer.from(publisher.root, "utf8"), { authorize })
    expect(store.snapshot().publishers.find(entry => entry.id === "dev-qa")).toMatchObject({ kind: "development", fingerprint: rootFingerprint(publisher) })

    const preview = await store.stage(first.bytes, { owner, client, scope: { type: "all" }, authorize })
    expect(preview.manifest).toMatchObject({ id: "dev-qa.cloudflare", publisher: "dev-qa", version: "1.0.0-dev.1" })
    expect(preview.digest).toBe(first.digest)
    expect(preview.compatibility.compatible).toBe(true)
    await store.payload(preview.transactionId, owner)
    await store.beginTrial(preview.transactionId, owner, { authorize })
    await store.commit(preview.transactionId, owner, { authorize, expectedRevision: preview.registryRevision })
    expect(store.snapshot().plugins.map(plugin => plugin.id)).toEqual(["dev-qa.cloudflare"])

    const second = signBundle(publisher, await createArchive(root, { publisher: "dev-qa", version: "1.0.0-dev.2" }))
    const update = await store.stage(second.bytes, { owner, client, scope: { type: "all" }, authorize })
    expect(update).toMatchObject({ operation: "update", oldVersion: "1.0.0-dev.1" })
    await store.payload(update.transactionId, owner)
    await store.beginTrial(update.transactionId, owner, { authorize })
    await store.commit(update.transactionId, owner, { authorize, expectedRevision: update.registryRevision })
    const installed = store.snapshot().plugins[0]
    expect(installed.manifest.version).toBe("1.0.0-dev.2")
    expect(installed.versions.map(version => version.manifest.version).sort()).toEqual(["1.0.0-dev.1", "1.0.0-dev.2"])
    expect(installed.versions.every(version => !version.unavailableReason)).toBe(true)

    const rollback = await store.rollback("dev-qa.cloudflare", first.digest, { owner, client, scope: { type: "all" }, authorize })
    await store.payload(rollback.transactionId, owner)
    await store.beginTrial(rollback.transactionId, owner, { authorize })
    await store.commit(rollback.transactionId, owner, { authorize, expectedRevision: rollback.registryRevision })
    expect(store.snapshot().plugins[0].manifest.version).toBe("1.0.0-dev.1")
  }, 30_000)

  it("rejects a bundle signed by a publisher whose root was not enrolled, even with the same name", async () => {
    const enrolled = createPublisher("dev-qa")
    await store.enrollDeveloper("dev-qa", "QA publisher", Buffer.from(enrolled.root, "utf8"), { authorize })
    const impostor = signBundle(createPublisher("dev-qa"), await createArchive(root, { publisher: "dev-qa" }))
    await expect(store.stage(impostor.bytes, { owner, client, scope: { type: "all" }, authorize })).rejects.toMatchObject({ code: "UNTRUSTED_PACKAGE" })
  }, 30_000)
})
