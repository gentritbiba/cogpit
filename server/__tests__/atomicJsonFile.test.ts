// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest"
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { writeOwnerOnlyJson } from "../atomicJsonFile"

let fixtureDir: string | null = null

afterEach(async () => {
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true })
  fixtureDir = null
})

describe("writeOwnerOnlyJson", () => {
  it("atomically replaces a file and leaves no temporary behind", async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "cogpit-atomic-json-"))
    const filePath = join(fixtureDir, "config.json")
    await writeFile(filePath, "old-value", "utf8")

    await writeOwnerOnlyJson(filePath, { current: true })

    await expect(readFile(filePath, "utf8")).resolves.toBe(JSON.stringify({ current: true }, null, 2))
    expect(await readdir(fixtureDir)).toEqual(["config.json"])
    expect((await stat(filePath)).mode & 0o777).toBe(0o600)
  })
})
