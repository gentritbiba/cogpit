// @vitest-environment node
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  CLICKUP_CONFIG_FILE,
  loadClickUpConfig,
  saveClickUpProjectLink,
  saveClickUpToken,
  setClickUpConfigPath,
} from "../../lib/clickupConfig"

const TOKEN = "pk_12345678_ABCDEFGHIJKLMNOP"
let root = ""
let file = ""

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cogpit-clickup-"))
  file = join(root, "nested", "clickup.json")
  setClickUpConfigPath(file)
  delete process.env.COGPIT_CLICKUP_TOKEN
  delete process.env.CLICKUP_API_TOKEN
})

afterEach(async () => {
  setClickUpConfigPath(CLICKUP_CONFIG_FILE)
  delete process.env.COGPIT_CLICKUP_TOKEN
  delete process.env.CLICKUP_API_TOKEN
  await rm(root, { recursive: true, force: true })
})

describe("ClickUp config", () => {
  it("starts empty when there is no file", async () => {
    expect(await loadClickUpConfig()).toEqual({ token: null, tokenFromEnv: false, projects: {} })
  })

  it("persists the token owner-only and keeps project links across token changes", async () => {
    await saveClickUpProjectLink("/repo", "901711539677")
    await saveClickUpToken(TOKEN)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(await loadClickUpConfig()).toEqual({
      token: TOKEN,
      tokenFromEnv: false,
      projects: { "/repo": "901711539677" },
    })

    await saveClickUpToken(null)
    const stored = JSON.parse(await readFile(file, "utf8"))
    expect(stored).toEqual({ projects: { "/repo": "901711539677" } })

    await saveClickUpProjectLink("/repo", null)
    expect((await loadClickUpConfig()).projects).toEqual({})
  })

  it("ignores malformed links and tokens on disk", async () => {
    await saveClickUpProjectLink("/repo", "901711539677")
    await saveClickUpToken(TOKEN)
    const { writeFile } = await import("node:fs/promises")
    await writeFile(file, JSON.stringify({ token: "nope", projects: { "/repo": "abc", "/ok": "1" } }))
    expect(await loadClickUpConfig()).toEqual({ token: null, tokenFromEnv: false, projects: { "/ok": "1" } })
  })

  it("lets the environment override the stored token", async () => {
    await saveClickUpToken(TOKEN)
    process.env.CLICKUP_API_TOKEN = "pk_88888888_YYYYYYYYYYYY"
    expect(await loadClickUpConfig()).toMatchObject({ token: "pk_88888888_YYYYYYYYYYYY", tokenFromEnv: true })
    process.env.COGPIT_CLICKUP_TOKEN = "pk_99999999_ZZZZZZZZZZZZ"
    expect(await loadClickUpConfig()).toMatchObject({ token: "pk_99999999_ZZZZZZZZZZZZ", tokenFromEnv: true })
  })
})
