// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PluginConnectionStore } from "../../plugins/connectionStore"
import { PluginStateStore } from "../../plugins/stateStore"
import { PluginDataError } from "../../plugins/privateStore"

let directory: string
const stores: { close(): Promise<void> }[] = []
const scope = { principalId: "owner", publisher: "dev-fixture", pluginId: "dev-fixture.panel" }
const saved = { definitionHash: "a".repeat(64), secret: "fixture-private-token", identity: {}, selected: {}, projects: {} }
const allow = () => {}
async function open(hook?: (step: string) => void | Promise<void>, revoke = vi.fn()) { const value = await PluginConnectionStore.open(join(directory, "connections"), revoke, hook); stores.push(value); return value }
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "cogpit-private-store-")) })
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); await rm(directory, { recursive: true, force: true }) })

describe("durable private plugin data", () => {
  it("persists credentials in owner-only files and isolates every identity component", async () => {
    const store = await open()
    await store.set(scope, "api", saved, 0, allow)
    expect(store.get({ ...scope, principalId: "other" }, "api", saved.definitionHash)).toBeUndefined()
    expect(store.get({ ...scope, publisher: "official" }, "api", saved.definitionHash)).toBeUndefined()
    expect(store.get({ ...scope, pluginId: "dev-fixture.other" }, "api", saved.definitionHash)).toBeUndefined()
    expect(store.get(scope, "other", saved.definitionHash)).toBeUndefined()
    if (process.platform !== "win32") { expect((await stat(join(directory, "connections"))).mode & 0o077).toBe(0); expect((await stat(join(directory, "connections", "connections.json"))).mode & 0o077).toBe(0) }
    await store.close()
    const reopened = await open()
    expect(reopened.revision).toBe(1)
    expect(reopened.get(scope, "api", saved.definitionHash)?.secret).toBe(saved.secret)
  })
  it("serializes competing revisions and revokes before the durable credential change", async () => {
    const revoke = vi.fn()
    const store = await open(undefined, revoke)
    const outcomes = await Promise.allSettled([store.set(scope, "a", saved, 0, allow), store.set(scope, "b", saved, 0, allow)])
    expect(outcomes.map(value => value.status)).toEqual(["fulfilled", "rejected"])
    expect(outcomes[1]).toMatchObject({ reason: { code: "STALE_ACTIVATION" } })
    expect(revoke).toHaveBeenCalledOnce()
  })
  it("checks authorization after fsync and preserves the previous credential on denial", async () => {
    let permitted = true
    const store = await open(step => { if (step === "private:file-synced") permitted = false })
    await expect(store.set(scope, "api", saved, 0, () => { if (!permitted) throw new PluginDataError("STALE_ACTIVATION", "changed") })).rejects.toMatchObject({ code: "STALE_ACTIVATION" })
    expect(store.revision).toBe(0)
    expect(await readFile(join(directory, "connections", "connections.json"), "utf8")).not.toContain(saved.secret)
  })
  it.each(["corrupt", "future"])("refuses %s documents without exposing or overwriting them", async kind => {
    const store = await open(); await store.close()
    const path = join(directory, "connections", "connections.json")
    const bytes = kind === "corrupt" ? `{"secret":"${saved.secret}",` : JSON.stringify({ formatVersion: 2, minWriterVersion: 2, revision: 0, connections: {}, clearing: [] })
    await writeFile(path, bytes)
    await expect(open()).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE", message: expect.not.stringContaining(saved.secret) })
    expect(await readFile(path, "utf8")).toBe(bytes)
  })
  it.skipIf(process.platform === "win32")("refuses an existing credential file readable by another user", async () => {
    const store = await open(); await store.set(scope, "api", saved, 0, allow); await store.close()
    await chmod(join(directory, "connections", "connections.json"), 0o644)
    await expect(open()).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" })
  })
  it("refuses a missing previously initialized credential document", async () => {
    const store = await open(); await store.set(scope, "api", saved, 0, allow); await store.close()
    const path = join(directory, "connections", "connections.json")
    await rm(path)
    await expect(open()).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" })
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" })
  })
  it("refuses a competing lifetime owner without leaking a private path", async () => {
    await open()
    await expect(open()).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE", message: expect.not.stringContaining(directory) })
  })
  it("retains an interrupted clear intent for restart completion", async () => {
    const store = await open(); await store.set(scope, "api", saved, 0, allow)
    await store.beginClear(scope, 1, allow); await store.close()
    const reopened = await open()
    expect(reopened.pendingClears()).toEqual([scope])
    expect(() => reopened.get(scope, "api", saved.definitionHash)).toThrow("being cleared")
    await reopened.finishClear(scope)
    expect(reopened.get(scope, "api", saved.definitionHash)).toBeUndefined()
  })
  it("isolates KV namespaces and keeps compatible state through disable or rollback", async () => {
    const state = await PluginStateStore.open(join(directory, "state"), vi.fn()); stores.push(state)
    const namespace = { ...scope, projectKey: "p_one", stateVersion: 1, quotaKiB: 1 }
    await state.write(namespace, "theme", { mode: "dark" }, allow)
    expect(state.get({ ...namespace, principalId: "another" }, "theme")).toBeNull()
    expect(state.get({ ...namespace, projectKey: "p_two" }, "theme")).toBeNull()
    expect(() => state.get({ ...namespace, stateVersion: 2 }, "theme")).toThrow("incompatible")
    await state.close()
    const reopened = await PluginStateStore.open(join(directory, "state"), vi.fn()); stores.push(reopened)
    expect(reopened.get(namespace, "theme")).toEqual({ mode: "dark" })
    await expect(reopened.write(namespace, "large", "x".repeat(1024), allow)).rejects.toMatchObject({ code: "RATE_LIMITED" })
    expect(reopened.get(namespace, "theme")).toEqual({ mode: "dark" })
    await reopened.clear(scope)
    expect(reopened.get(namespace, "theme")).toBeNull()
  })
  it("rejects aggregate JSON complexity without disabling saved state", async () => {
    const state = await PluginStateStore.open(join(directory, "state"), vi.fn()); stores.push(state)
    const namespace = { ...scope, projectKey: null, stateVersion: 1, quotaKiB: 1024 }
    let rejected = false
    for (let index = 0; index < 60; index++) {
      try { await state.write(namespace, `value${index}`, Array(1000).fill(0), allow) }
      catch (error) { expect(error).toMatchObject({ code: "RATE_LIMITED" }); rejected = true; break }
    }
    expect(rejected).toBe(true)
    expect(state.get(namespace, "value0")).toHaveLength(1000)
    await state.write(namespace, "value0", null, allow)
    expect(state.get(namespace, "value0")).toBeNull()
  })
})
