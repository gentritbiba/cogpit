// @vitest-environment node
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { backupLegacyClickUpConfig, readLegacyClickUpConfig } from "../../lib/clickupConfig"

const TOKEN = "pk_12345678_ABCDEFGHIJKLMNOP"
let root: string, file: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cogpit-clickup-reader-")); file = join(root, "clickup.json") })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
describe("read-only ClickUp legacy configuration", () => {
  it("requires an explicit path and treats a missing source as absent", async () => {
    expect(await readLegacyClickUpConfig(file)).toBeNull()
    await expect(readLegacyClickUpConfig("clickup.json")).rejects.toMatchObject({ code: "INVALID_REQUEST" })
  })
  it("keeps exact original bytes in an owner-only backup", async () => {
    const bytes = JSON.stringify({ token: TOKEN, projects: { "/unopened/project": "1234" } }, null, 2)
    await writeFile(file, bytes)
    const config = (await readLegacyClickUpConfig(file))!
    const backup = await backupLegacyClickUpConfig(file, config, Date.UTC(2026, 8, 14), () => {})
    expect(await readFile(join(root, backup), "utf8")).toBe(bytes)
    expect(await readFile(file, "utf8")).toBe(bytes)
    if (process.platform !== "win32") expect((await stat(join(root, backup))).mode & 0o077).toBe(0)
  })
  it.each(['{"token":"private-secret",', '{"token":"nope","projects":{}}', '{"projects":{"/a":"1","/a":"2"}}'])('preserves malformed legacy data %s', async bytes => {
    await writeFile(file, bytes)
    await expect(readLegacyClickUpConfig(file)).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE", message: expect.not.stringContaining("private-secret") })
    expect(await readFile(file, "utf8")).toBe(bytes)
  })
})
