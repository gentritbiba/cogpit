// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { writeOwnerOnlyJson } from "../atomicJsonFile"

let fixtureDir: string
let filePath: string

beforeEach(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), "cogpit-atomic-json-"))
  filePath = join(fixtureDir, "config.json")
  await writeFile(filePath, "old-value", "utf8")
})

afterEach(async () => {
  await rm(fixtureDir, { recursive: true, force: true })
})

describe("writeOwnerOnlyJson", () => {
  it("atomically replaces a file and leaves no temporary behind", async () => {
    await writeOwnerOnlyJson(filePath, { current: true })

    await expect(readFile(filePath, "utf8")).resolves.toBe(JSON.stringify({ current: true }, null, 2))
    expect(await readdir(fixtureDir)).toEqual(["config.json"])
  })

  // Windows has no POSIX modes — chmod only toggles the read-only bit there, so
  // a real file can never report 0600.
  it.skipIf(process.platform === "win32")("leaves the replacement owner-only", async () => {
    await writeOwnerOnlyJson(filePath, { current: true })

    expect((await stat(filePath)).mode & 0o777).toBe(0o600)
  })
})
