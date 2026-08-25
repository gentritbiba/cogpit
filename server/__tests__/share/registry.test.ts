// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtemp, rm, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

type AtomicWrite = typeof import("../../atomicJsonFile").writeOwnerOnlyJson

const atomicWrite = vi.hoisted(() => ({
  implementation: undefined as AtomicWrite | undefined,
}))

vi.mock("../../atomicJsonFile", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../atomicJsonFile")>()
  return {
    ...original,
    writeOwnerOnlyJson: (...args: Parameters<AtomicWrite>) =>
      (atomicWrite.implementation ?? original.writeOwnerOnlyJson)(...args),
  }
})

import {
  initShareRegistry,
  createShare,
  getShare,
  listShares,
  removeShare,
  rotateSharePassword,
  touchShare,
} from "../../share/registry"
import { verifyPassword } from "../../password-utils"

let dir: string

// Windows has no POSIX modes — chmod only toggles the read-only bit there, so
// a real file can never report 0600.
const POSIX_MODES_UNSUPPORTED = process.platform === "win32"

beforeEach(async () => {
  atomicWrite.implementation = undefined
  dir = await mkdtemp(join(tmpdir(), "cogpit-shares-"))
  await initShareRegistry(dir)
})
afterEach(async () => {
  atomicWrite.implementation = undefined
  await rm(dir, { recursive: true, force: true })
})

const INPUT = { sessionId: "sess-1", dirName: "-Users-me-proj", fileName: "sess-1.jsonl" }

const registryFile = () => join(dir, "shares.local.json")

describe("share registry", () => {
  it("returns the plaintext passphrase exactly once, at creation", async () => {
    const created = await createShare(INPUT)
    expect(created.passphrase).toMatch(/-\d{2}$/)
    const stored = getShare("sess-1")
    expect(stored).toBeDefined()
    expect(stored).not.toHaveProperty("passphrase")
    expect(verifyPassword(created.passphrase, stored!.passwordHash)).toBe(true)
  })

  it("never persists the plaintext passphrase", async () => {
    const created = await createShare(INPUT)
    const raw = await readFile(registryFile(), "utf-8")
    expect(raw).not.toContain(created.passphrase)
  })

  it.skipIf(POSIX_MODES_UNSUPPORTED)("writes the file owner-only", async () => {
    await createShare(INPUT)
    const info = await stat(registryFile())
    expect(info.mode & 0o777).toBe(0o600)
  })

  it("reloads shares from disk", async () => {
    const created = await createShare(INPUT)
    await initShareRegistry(dir)
    expect(verifyPassword(created.passphrase, getShare("sess-1")!.passwordHash)).toBe(true)
  })

  it("re-sharing an already shared session replaces the passphrase", async () => {
    const first = await createShare(INPUT)
    const second = await createShare(INPUT)
    expect(second.passphrase).not.toBe(first.passphrase)
    expect(listShares()).toHaveLength(1)
    expect(verifyPassword(first.passphrase, getShare("sess-1")!.passwordHash)).toBe(false)
  })

  it("rotates the passphrase in place", async () => {
    const first = await createShare(INPUT)
    const rotated = await rotateSharePassword("sess-1")
    expect(rotated).not.toBeNull()
    expect(verifyPassword(first.passphrase, getShare("sess-1")!.passwordHash)).toBe(false)
    expect(verifyPassword(rotated!.passphrase, getShare("sess-1")!.passwordHash)).toBe(true)
  })

  it("rotating an unknown share returns null", async () => {
    expect(await rotateSharePassword("nope")).toBeNull()
  })

  it("removes shares", async () => {
    await createShare(INPUT)
    expect(await removeShare("sess-1")).toBe(true)
    expect(getShare("sess-1")).toBeUndefined()
    expect(await removeShare("sess-1")).toBe(false)
  })

  it("listShares never exposes the hash", async () => {
    await createShare(INPUT)
    expect(listShares()[0]).not.toHaveProperty("passwordHash")
  })

  it("starts empty on corrupt JSON instead of throwing", async () => {
    await createShare(INPUT)
    await writeFile(registryFile(), "{not json")
    await initShareRegistry(dir)
    expect(listShares()).toHaveLength(0)
  })

  it("serializes concurrent creates without losing records", async () => {
    await Promise.all([
      createShare({ ...INPUT, sessionId: "a" }),
      createShare({ ...INPUT, sessionId: "b" }),
      createShare({ ...INPUT, sessionId: "c" }),
    ])
    expect(listShares().map((s) => s.sessionId).sort()).toEqual(["a", "b", "c"])
  })

  it("touches lastAccessAt in memory without rewriting the file", async () => {
    await createShare(INPUT)
    const before = getShare("sess-1")!.lastAccessAt
    const persistedBefore = await readFile(registryFile(), "utf-8")

    const now = vi.spyOn(Date, "now").mockReturnValue(before + 60_000)
    touchShare("sess-1")
    touchShare("never-shared")
    now.mockRestore()

    expect(getShare("sess-1")!.lastAccessAt).toBe(before + 60_000)
    expect(await readFile(registryFile(), "utf-8")).toBe(persistedBefore)
  })

  it("rolls back a failed persist and keeps the queue usable", async () => {
    const created = await createShare(INPUT)
    const failure = new Error("simulated persistence failure")
    atomicWrite.implementation = async () => {
      throw failure
    }

    await expect(rotateSharePassword("sess-1")).rejects.toBe(failure)
    expect(verifyPassword(created.passphrase, getShare("sess-1")!.passwordHash)).toBe(true)

    await expect(removeShare("sess-1")).rejects.toBe(failure)
    expect(getShare("sess-1")).toBeDefined()

    atomicWrite.implementation = undefined
    expect(await removeShare("sess-1")).toBe(true)
    expect(listShares()).toHaveLength(0)
  })
})
