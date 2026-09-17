// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, readdir, rm, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { openPluginStore, type PluginStore } from "../../plugins/store"
import { host, owner } from "./fixtures/storeSigning"

let directory: string
let root: string
const children: ChildProcess[] = []
const stores: PluginStore[] = []
const worker = fileURLToPath(new URL("./fixtures/storeWorker.ts", import.meta.url))
async function start(mode: "hold" | "crash" | "bootstrap" | "repair", step = "") {
  const child = spawn("bun", [worker, root, mode, step], { stdio: ["ignore", "ignore", "pipe", "ipc"] })
  children.push(child)
  let stderr = ""; child.stderr?.on("data", data => { stderr += data.toString() })
  const closed = once(child, "close")
  const checkpoint = { step: "", killed: false }
  child.on("message", (message: { crashStep?: string }) => {
    if (message.crashStep) {
      checkpoint.step = message.crashStep
      checkpoint.killed = child.kill("SIGKILL")
    }
  })
  const ready = await Promise.race([
    once(child, "message").then(([message]) => message as { ready: boolean; transactionId?: string; digest?: string }),
    once(child, "exit").then(([code, signal]) => { throw new Error(`Store worker exited before readiness: ${code}/${signal}: ${stderr}`) }),
  ])
  return { child, ready, closed, checkpoint, stderr: () => stderr }
}
async function expectCrash(worker: Awaited<ReturnType<typeof start>>, step: string) {
  await worker.closed
  expect(worker.checkpoint).toEqual({ step, killed: true })
  expect(worker.stderr()).toBe("")
  if (process.platform === "win32") {
    expect(worker.child.signalCode === "SIGKILL" || (worker.child.exitCode !== null && worker.child.exitCode !== 0)).toBe(true)
  } else {
    expect(worker.child.signalCode).toBe("SIGKILL")
  }
}
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "cogpit-store-crash-")); root = join(directory, "plugins") })
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit")
      if (process.platform !== "win32") child.kill("SIGCONT")
      child.kill("SIGKILL"); await exited
    }
  }
  for (const store of stores.splice(0)) await store.close()
  await rm(directory, { recursive: true, force: true })
})

describe("plugin store process ownership and crash recovery", { timeout: process.platform === "win32" ? 20_000 : 5_000 }, () => {
  it.each([
    ["repair-quarantine:renamed", false], ["repair-quarantine:directory-synced", false],
    ["package:file-synced", false], ["package:renamed", false], ["package:directory-synced", false],
    ["repair-registry:file-synced", false], ["repair-registry:renamed", true], ["repair-registry:directory-synced", true],
  ] as const)("keeps interrupted repair quarantined after SIGKILL at %s until verified bytes are durable", async (step, repaired) => {
    const worker = await start("repair", step)
    const { ready } = worker
    await expectCrash(worker, step)
    const old = new Date(Date.now() - 60000); await utimes(join(root, ".store.lock"), old, old)
    const recovered = await openPluginStore(root, { host }); stores.push(recovered)
    expect(recovered.snapshot()).toMatchObject({ available: true, plugins: [{ enabled: false, selectedDigest: ready.digest }] })
    if (repaired) expect(await recovered.payload(ready.digest!)).toBeInstanceOf(Buffer)
    else await expect(recovered.payload(ready.digest!)).rejects.toMatchObject({ code: "PACKAGE_UNAVAILABLE" })
    const [backup] = await readdir(join(root, "quarantine"))
    expect(await readFile(join(root, "quarantine", backup), "utf8")).toBe("original damaged bytes")
  })

  it("refuses a live writer and recovers after external process termination", async () => {
    const { child } = await start("hold")
    const second = await openPluginStore(root, { host }); stores.push(second)
    expect(second.snapshot()).toMatchObject({ available: false, error: expect.stringContaining("live owner") })
    const exited = once(child, "exit")
    expect(child.kill("SIGKILL")).toBe(true)
    await exited
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    const old = new Date(Date.now() - 60000); await utimes(join(root, ".store.lock"), old, old)
    const recovered = await openPluginStore(root, { host }); stores.push(recovered)
    expect(recovered.snapshot()).toMatchObject({ available: true, revision: 0, plugins: [] })
  })

  it.each(["initialize-intent", "initialize-registry", "initialize-trust"].flatMap(label => ["file-synced", "renamed", "directory-synced"].map(step => `${label}:${step}`)))("recovers empty-store initialization after SIGKILL at %s", async step => {
    await expectCrash(await start("bootstrap", step), step)
    const old = new Date(Date.now() - 60000); await utimes(join(root, ".store.lock"), old, old)
    const recovered = await openPluginStore(root, { host }); stores.push(recovered)
    expect(recovered.snapshot()).toMatchObject({ available: true, revision: 0, plugins: [], publishers: [] })
    expect((await readdir(root)).some(name => name.startsWith(".write-") || name === "initialize.json")).toBe(false)
  })

  it.skipIf(process.platform === "win32")("refuses a second writer while the live owner is paused beyond its heartbeat", async () => {
    const { child } = await start("hold")
    child.kill("SIGSTOP")
    const old = new Date(Date.now() - 60000)
    await utimes(join(root, ".store.lock"), old, old)
    const second = await openPluginStore(root, { host }); stores.push(second)
    expect(second.snapshot()).toMatchObject({ available: false, error: expect.stringContaining("live owner") })
    child.kill("SIGCONT")
    const exited = once(child, "exit"); child.send("close"); await exited
    const reopened = await openPluginStore(root, { host }); stores.push(reopened)
    expect(reopened.snapshot().available).toBe(true)
  })

  it.each([
    ["commit-intent:file-synced", false],
    ["commit-intent:renamed", false],
    ["commit-intent:directory-synced", false],
    ["commit-registry:file-synced", false],
    ["commit-registry:renamed", true],
    ["commit-registry:directory-synced", true],
    ["committed:file-synced", true],
    ["committed:renamed", true],
    ["committed:directory-synced", true],
  ] as const)("recovers SIGKILL at %s using the durable registry pointer", async (step, promoted) => {
    const worker = await start("crash", step)
    const { ready } = worker
    await expectCrash(worker, step)
    const old = new Date(Date.now() - 60000); await utimes(join(root, ".store.lock"), old, old)
    const recovered = await openPluginStore(root, { host }); stores.push(recovered)
    expect(recovered.snapshot()).toMatchObject({ available: true, revision: promoted ? 1 : 0 })
    expect(recovered.snapshot().plugins).toHaveLength(promoted ? 1 : 0)
    if (promoted) expect(recovered.snapshot().plugins[0].selectedDigest).toBe(ready.digest)
    expect((await recovered.transactionOutcome(ready.transactionId!, owner)).status).toBe(promoted ? "committed" : "cancelled")
    const trust = JSON.parse(await readFile(join(root, "trust.json"), "utf8"))
    expect(trust.publishers["dev-test"].checkpoint.verifiedAt).toBeGreaterThan(0)
  })
})
