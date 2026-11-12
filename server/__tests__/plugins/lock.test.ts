// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const os = vi.hoisted(() => ({ hostname: "Mac.lan" }))
vi.mock("node:os", async importOriginal => ({ ...await importOriginal<typeof import("node:os")>(), hostname: () => os.hostname }))
const { acquirePluginStoreLock } = await import("../../plugins/lock")

let root: string
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid
const writeOwner = (record: object) => writeFile(join(root, "owner.json"), JSON.stringify(record), { mode: 0o600 })
const readOwner = async () => JSON.parse(await readFile(join(root, "owner.json"), "utf8"))
async function staleLock() {
  await mkdir(join(root, ".store.lock"))
  const old = new Date(Date.now() - 60000)
  await utimes(join(root, ".store.lock"), old, old)
}
/** The record a killed owner leaves behind: Electron's quit kills the server without releasing its stores. */
async function crashLeftover(options: { lock: boolean }) {
  const lock = await acquirePluginStoreLock(root, () => {})
  const record = await readOwner()
  await lock.release()
  await writeOwner({ ...record, pid: deadPid() })
  if (options.lock) await staleLock()
  return record
}
const acquire = async () => {
  const lock = await acquirePluginStoreLock(root, () => {})
  await lock.release()
}

beforeEach(async () => { os.hostname = "Mac.lan"; root = await mkdtemp(join(tmpdir(), "cogpit-store-lock-")) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe("plugin store ownership", () => {
  it.each([true, false])("recovers this machine's crash leftover after the network renames the host (lock left: %s)", async lock => {
    await crashLeftover({ lock })
    os.hostname = "Gentrits-MacBook-Pro-2.local"
    await expect(acquire()).resolves.toBeUndefined()
  })

  it("keeps ownership when the host is renamed while it runs", async () => {
    const compromised = vi.fn()
    const lock = await acquirePluginStoreLock(root, compromised)
    os.hostname = "Gentrits-MacBook-Pro-2.local"
    await expect(lock.assertOwned()).resolves.toBeUndefined()
    await lock.release()
    expect(compromised).not.toHaveBeenCalled()
  })

  it("takes over a legacy record from a renamed host once no process holds its lock", async () => {
    await writeOwner({ formatVersion: 1, hostname: "Mac.lan", pid: deadPid(), token: randomUUID(), startedAt: Date.now() - 1000 })
    os.hostname = "Gentrits-MacBook-Pro-2.local"
    const lock = await acquirePluginStoreLock(root, () => {})
    expect(await readOwner()).toMatchObject({ formatVersion: 2, pid: process.pid })
    await lock.release()
  })

  it.each([
    ["another machine", { formatVersion: 2, machine: "another-machine" }],
    ["a legacy record from another host", { formatVersion: 1, hostname: "nfs-peer.example" }],
  ])("refuses a lock still held under %s", async (_label, identity) => {
    await writeOwner({ ...identity, pid: deadPid(), token: randomUUID(), startedAt: Date.now() - 1000 })
    await staleLock()
    await expect(acquire()).rejects.toThrow("another host")
  })

  it("keys ownership to the platform's install id rather than the hostname", async () => {
    const lock = await acquirePluginStoreLock(root, () => {})
    const record = await readOwner()
    await lock.release()
    expect(record.machine).not.toBe(createHash("sha256").update("hostname:Mac.lan").digest("hex"))
    if (process.platform !== "win32") expect(record.boot).toEqual(expect.any(String))
  })

  it.skipIf(process.platform === "win32")("does not mistake a pid reused after a reboot for the owner", async () => {
    const record = await crashLeftover({ lock: false })
    await writeOwner({ ...record, pid: process.ppid })
    await expect(acquire()).rejects.toThrow(`live owner process ${process.ppid}`)
    await writeOwner({ ...record, pid: process.ppid, boot: "previous-boot" })
    await expect(acquire()).resolves.toBeUndefined()
  })

  it("treats its own pid as the owner only while this process holds the record", async () => {
    const record = await crashLeftover({ lock: false })
    await writeOwner({ ...record, pid: process.pid })
    const lock = await acquirePluginStoreLock(root, () => {})
    await expect(acquirePluginStoreLock(root, () => {})).rejects.toThrow(`live owner process ${process.pid}`)
    await lock.release()
  })

  it("reports a record from a newer Cogpit as a newer format", async () => {
    await writeOwner({ formatVersion: 3 })
    await expect(acquire()).rejects.toThrow("newer format")
  })
})
