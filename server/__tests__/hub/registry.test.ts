// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtemp, rm, stat, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

type AtomicWrite = typeof import("../../atomicJsonFile").writeOwnerOnlyJson

const atomicWrite = vi.hoisted(() => ({
  implementation: undefined as AtomicWrite | undefined,
  original: undefined as AtomicWrite | undefined,
}))

vi.mock("../../atomicJsonFile", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../atomicJsonFile")>()
  atomicWrite.original = original.writeOwnerOnlyJson
  return {
    ...original,
    writeOwnerOnlyJson: (...args: Parameters<AtomicWrite>) =>
      (atomicWrite.implementation ?? original.writeOwnerOnlyJson)(...args),
  }
})

import {
  initDeviceRegistry,
  addDevice,
  getDevice,
  listDevices,
  updateDevice,
  removeDevice,
  setDeviceRuntime,
  validateDeviceHost,
} from "../../hub/registry"

let dir: string

async function freshRegistry(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "cogpit-registry-"))
  await initDeviceRegistry(d)
  return d
}

beforeEach(async () => {
  atomicWrite.implementation = undefined
  dir = await freshRegistry()
})

afterEach(async () => {
  atomicWrite.implementation = undefined
  await rm(dir, { recursive: true, force: true })
})

// ── addDevice / getDevice ────────────────────────────────────────────

describe("addDevice", () => {
  it("mints a dev_ id, defaults the port, and persists a 0600 file", async () => {
    const device = await addDevice({ name: "Studio", host: "10.0.0.5", auth: "password", password: "hunter2secret" })

    expect(device.id).toMatch(/^dev_[0-9a-f]{16}$/)
    expect(device.port).toBe(19384)
    expect(device.addedAt).toBeGreaterThan(0)

    const filePath = join(dir, "devices.local.json")
    const fileStat = await stat(filePath)
    expect(fileStat.mode & 0o777).toBe(0o600)
  })

  it("getDevice returns the full record including the password (internal use)", async () => {
    const { id } = await addDevice({ name: "Studio", host: "10.0.0.5", auth: "password", password: "hunter2secret" })
    const device = getDevice(id)
    expect(device?.password).toBe("hunter2secret")
  })

  it("does not store a password for auth: none devices", async () => {
    const { id } = await addDevice({ name: "Tunnel", host: "10.0.0.9", auth: "none", password: "ignored" })
    expect(getDevice(id)?.password).toBeUndefined()
  })

  it("defaults the port to 443 for tls devices and persists the tls flag", async () => {
    const { id } = await addDevice({ name: "Edge", host: "cogpit.example.com", tls: true, auth: "password", password: "hunter2secret" })
    const device = getDevice(id)
    expect(device?.port).toBe(443)
    expect(device?.tls).toBe(true)

    await initDeviceRegistry(dir)
    expect(getDevice(id)?.tls).toBe(true)
  })

  it("does not serialize tls for plain-http devices", async () => {
    await addDevice({ name: "Studio", host: "10.0.0.5", auth: "password", password: "hunter2secret" })
    const onDisk = await readFile(join(dir, "devices.local.json"), "utf-8")
    expect(onDisk).not.toContain("tls")
  })
})

// ── listDevices ──────────────────────────────────────────────────────

describe("listDevices", () => {
  it("never serializes the password and includes runtime status", async () => {
    const { id } = await addDevice({ name: "Studio", host: "10.0.0.5", auth: "password", password: "hunter2secret" })

    const list = listDevices()
    expect(list).toHaveLength(1)
    const entry = list[0]

    expect(entry.id).toBe(id)
    expect("password" in entry).toBe(false)
    expect(JSON.stringify(list)).not.toContain("hunter2secret")
    expect(entry.runtime).toEqual({ authState: "unknown" })
  })

  it("preserves insertion (registry) order", async () => {
    const a = await addDevice({ name: "A", host: "10.0.0.1", auth: "password", password: "passwordone1" })
    const b = await addDevice({ name: "B", host: "10.0.0.2", auth: "password", password: "passwordtwo2" })
    expect(listDevices().map((d) => d.id)).toEqual([a.id, b.id])
  })
})

// ── setDeviceRuntime ─────────────────────────────────────────────────

describe("setDeviceRuntime", () => {
  it("merges patches and surfaces them through listDevices", async () => {
    const { id } = await addDevice({ name: "Studio", host: "10.0.0.5", auth: "password", password: "hunter2secret" })

    setDeviceRuntime(id, { authState: "ok", lastProbe: 1234 })
    setDeviceRuntime(id, { lastHello: { version: "1.0.1" } })

    const entry = listDevices().find((d) => d.id === id)
    expect(entry?.runtime).toEqual({ authState: "ok", lastProbe: 1234, lastHello: { version: "1.0.1" } })
  })
})

// ── updateDevice / removeDevice ──────────────────────────────────────

describe("updateDevice", () => {
  it("patches fields and persists", async () => {
    const { id } = await addDevice({ name: "Studio", host: "10.0.0.5", auth: "password", password: "hunter2secret" })
    const updated = await updateDevice(id, { name: "Studio Mac", host: "10.0.0.6" })
    expect(updated?.name).toBe("Studio Mac")
    expect(updated?.host).toBe("10.0.0.6")
    expect(getDevice(id)?.host).toBe("10.0.0.6")
  })

  it("clears the password when switching to auth: none", async () => {
    const { id } = await addDevice({ name: "Studio", host: "10.0.0.5", auth: "password", password: "hunter2secret" })
    const updated = await updateDevice(id, { auth: "none" })
    expect(updated?.password).toBeUndefined()
  })

  it("returns undefined for an unknown id", async () => {
    expect(await updateDevice("dev_nope", { name: "x" })).toBeUndefined()
  })
})

describe("removeDevice", () => {
  it("removes a device and its runtime", async () => {
    const { id } = await addDevice({ name: "Studio", host: "10.0.0.5", auth: "password", password: "hunter2secret" })
    expect(await removeDevice(id)).toBe(true)
    expect(getDevice(id)).toBeUndefined()
    expect(listDevices()).toHaveLength(0)
    expect(await removeDevice(id)).toBe(false)
  })
})

// ── Persistence roundtrip / resilience ───────────────────────────────

describe("persistence", () => {
  it("serializes concurrent snapshots and commits memory only after each write", async () => {
    let releaseFirstWrite = (): void => undefined
    let markFirstWriteStarted = (): void => undefined
    const firstWriteReleased = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve
    })
    const firstWriteStarted = new Promise<void>((resolve) => {
      markFirstWriteStarted = resolve
    })
    const snapshotNames: string[][] = []
    let writeCount = 0

    atomicWrite.implementation = async (...args) => {
      writeCount += 1
      const snapshot = args[1] as Array<{ name: string }>
      snapshotNames.push(snapshot.map((device) => device.name))
      if (writeCount === 1) {
        markFirstWriteStarted()
        await firstWriteReleased
      }
      await atomicWrite.original!(...args)
    }

    const firstAdd = addDevice({
      name: "First",
      host: "10.0.0.1",
      auth: "password",
      password: "passwordone1",
    })
    await firstWriteStarted
    const secondAdd = addDevice({
      name: "Second",
      host: "10.0.0.2",
      auth: "password",
      password: "passwordtwo2",
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    let orderingFailure: unknown
    try {
      expect(snapshotNames).toEqual([["First"]])
      expect(listDevices()).toEqual([])
    } catch (error) {
      orderingFailure = error
    } finally {
      releaseFirstWrite()
    }

    const [first, second] = await Promise.all([firstAdd, secondAdd])
    if (orderingFailure) throw orderingFailure

    expect(snapshotNames).toEqual([["First"], ["First", "Second"]])
    expect(listDevices().map((device) => device.id)).toEqual([first.id, second.id])
    const persisted = JSON.parse(
      await readFile(join(dir, "devices.local.json"), "utf-8"),
    ) as Array<{ id: string }>
    expect(persisted.map((device) => device.id)).toEqual([first.id, second.id])
  })

  it("rolls back failed mutations and keeps the persistence queue usable", async () => {
    const original = await addDevice({
      name: "Studio",
      host: "10.0.0.5",
      auth: "password",
      password: "hunter2secret",
    })
    setDeviceRuntime(original.id, { authState: "ok", lastProbe: 1234 })

    const failure = new Error("simulated persistence failure")
    atomicWrite.implementation = async () => {
      throw failure
    }

    await expect(updateDevice(original.id, { name: "Uncommitted" })).rejects.toBe(failure)
    expect(getDevice(original.id)?.name).toBe("Studio")

    await expect(removeDevice(original.id)).rejects.toBe(failure)
    expect(getDevice(original.id)?.name).toBe("Studio")
    expect(listDevices()[0]?.runtime).toEqual({ authState: "ok", lastProbe: 1234 })

    await expect(addDevice({
      name: "Uncommitted add",
      host: "10.0.0.6",
      auth: "none",
    })).rejects.toBe(failure)
    expect(listDevices().map((device) => device.name)).toEqual(["Studio"])
    const rolledBackDisk = JSON.parse(
      await readFile(join(dir, "devices.local.json"), "utf-8"),
    ) as Array<{ name: string }>
    expect(rolledBackDisk.map((device) => device.name)).toEqual(["Studio"])

    atomicWrite.implementation = undefined
    const recovered = await updateDevice(original.id, { name: "Committed" })
    expect(recovered?.name).toBe("Committed")
    expect(getDevice(original.id)?.name).toBe("Committed")
    const persisted = JSON.parse(
      await readFile(join(dir, "devices.local.json"), "utf-8"),
    ) as Array<{ name: string }>
    expect(persisted.map((device) => device.name)).toEqual(["Committed"])
  })

  it("reloads persisted devices on re-init", async () => {
    const { id } = await addDevice({ name: "Studio", host: "10.0.0.5", auth: "password", password: "hunter2secret" })

    await initDeviceRegistry(dir)
    const device = getDevice(id)
    expect(device?.name).toBe("Studio")
    expect(device?.password).toBe("hunter2secret")
    // runtime is not persisted; it resets to unknown after reload
    expect(listDevices()[0].runtime).toEqual({ authState: "unknown" })
  })

  it("starts empty when the file is missing", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "cogpit-registry-empty-"))
    await initDeviceRegistry(emptyDir)
    expect(listDevices()).toEqual([])
    await rm(emptyDir, { recursive: true, force: true })
  })

  it("starts empty when the file is corrupt", async () => {
    const badDir = await mkdtemp(join(tmpdir(), "cogpit-registry-bad-"))
    await writeFile(join(badDir, "devices.local.json"), "not-json{{{", "utf-8")
    await initDeviceRegistry(badDir)
    expect(listDevices()).toEqual([])
    await rm(badDir, { recursive: true, force: true })
  })

  it("re-chmods an already-existing file back to 0600 on write", async () => {
    const { id } = await addDevice({ name: "Studio", host: "10.0.0.5", auth: "password", password: "hunter2secret" })
    const filePath = join(dir, "devices.local.json")
    // Loosen the mode, then trigger another write.
    const { chmod } = await import("node:fs/promises")
    await chmod(filePath, 0o644)
    await updateDevice(id, { name: "Studio Mac" })
    expect((await stat(filePath)).mode & 0o777).toBe(0o600)
  })

  it("repairs an existing registry to 0600 before loading credentials", async () => {
    const { id } = await addDevice({
      name: "Studio",
      host: "10.0.0.5",
      auth: "password",
      password: "hunter2secret",
    })
    const filePath = join(dir, "devices.local.json")
    const { chmod } = await import("node:fs/promises")
    await chmod(filePath, 0o644)

    await initDeviceRegistry(dir)

    expect(getDevice(id)?.password).toBe("hunter2secret")
    expect((await stat(filePath)).mode & 0o777).toBe(0o600)
  })

  it("persisted JSON never contains a password key exposure via listDevices output shape", async () => {
    await addDevice({ name: "Studio", host: "10.0.0.5", auth: "password", password: "hunter2secret" })
    // The on-disk file legitimately holds the password (0600); the API surface
    // (listDevices) must not. Confirm the two differ as designed.
    const onDisk = await readFile(join(dir, "devices.local.json"), "utf-8")
    expect(onDisk).toContain("hunter2secret")
    expect(JSON.stringify(listDevices())).not.toContain("hunter2secret")
  })
})

// ── validateDeviceHost ───────────────────────────────────────────────

describe("validateDeviceHost", () => {
  const rejected = [
    "127.0.0.1",
    "127.1.2.3",
    "localhost",
    "LOCALHOST",
    "foo.localhost",
    "::1",
    "[::1]",
    "169.254.1.1",
    "0.0.0.0",
    "",
    "   ",
    // SSRF bypass vectors: userinfo hides the real host, and non-dotted IPv4
    // encodings (decimal / hex / octal) plus IPv4-mapped IPv6 all resolve to
    // loopback / link-local when interpolated into a fetch URL.
    "foo@127.0.0.1",
    "x@169.254.169.254",
    "user:pass@10.0.0.5",
    "2130706433", // decimal 127.0.0.1
    "0x7f000001", // hex 127.0.0.1
    "0177.0.0.1", // octal-leading 127.0.0.1
    "0xA9FEA9FE", // hex 169.254.169.254
    "2852039166", // decimal 169.254.169.254
    "::ffff:127.0.0.1", // IPv4-mapped IPv6 loopback
  ]

  for (const host of rejected) {
    it(`rejects ${JSON.stringify(host)} without allowLocalTunnel`, () => {
      expect(validateDeviceHost(host, false)).not.toBeNull()
    })
  }

  const accepted = ["10.0.0.5", "192.168.1.20", "studio.local", "example.com", "8.8.8.8"]
  for (const host of accepted) {
    it(`accepts ${JSON.stringify(host)}`, () => {
      expect(validateDeviceHost(host, false)).toBeNull()
    })
  }

  it("allows loopback hosts when allowLocalTunnel is true", () => {
    expect(validateDeviceHost("127.0.0.1", true)).toBeNull()
    expect(validateDeviceHost("localhost", true)).toBeNull()
    expect(validateDeviceHost("::1", true)).toBeNull()
  })

  it("rejects userinfo hosts even when allowLocalTunnel is true", () => {
    // The tunnel escape hatch relaxes loopback checks, but a `user@host` form is
    // never legitimate — it's only ever used to smuggle the real target.
    expect(validateDeviceHost("foo@127.0.0.1", true)).not.toBeNull()
    expect(validateDeviceHost("x@169.254.169.254", true)).not.toBeNull()
    expect(validateDeviceHost("user:pass@10.0.0.5", true)).not.toBeNull()
  })
})
