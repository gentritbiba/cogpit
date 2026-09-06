// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { browserAgentEnv, browserPluginPaths } from "../../browser/agentEnv"
import { binDir, NO_COGPIT_SESSION, pluginDir, shimPath } from "../../browser/paths"
import { ensurePlugin } from "../../browser/skill"

let root = ""
let previousHome: string | undefined

beforeEach(() => {
  previousHome = process.env.COGPIT_BROWSER_HOME
  root = mkdtempSync(join(tmpdir(), "cogpit-browser-"))
  process.env.COGPIT_BROWSER_HOME = join(root, "browser")
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.COGPIT_BROWSER_HOME
  else process.env.COGPIT_BROWSER_HOME = previousHome
  rmSync(root, { recursive: true, force: true })
})

function writeShim(): void {
  mkdirSync(binDir(), { recursive: true })
  writeFileSync(shimPath(), "#!/usr/bin/env bash\n", { mode: 0o755 })
}

describe("browserAgentEnv", () => {
  it("prepends the shim directory to PATH and sets the session id", () => {
    writeShim()
    const env = browserAgentEnv({ PATH: "/usr/bin", FOO: "bar" }, "session-1")
    expect(env.PATH).toBe(`${binDir()}${delimiter}/usr/bin`)
    expect(env.COGPIT_SESSION_ID).toBe("session-1")
    expect(env.FOO).toBe("bar")
  })

  it("does not prepend twice when the shim directory already leads PATH", () => {
    writeShim()
    const path = `${binDir()}${delimiter}/usr/bin`
    expect(browserAgentEnv({ PATH: path }, "session-1").PATH).toBe(path)
  })

  it("prepends again when the shim directory is present but not first", () => {
    writeShim()
    const path = `/usr/bin${delimiter}${binDir()}`
    expect(browserAgentEnv({ PATH: path }, "session-1").PATH).toBe(`${binDir()}${delimiter}${path}`)
  })

  it("becomes the whole PATH when the base has none", () => {
    writeShim()
    expect(browserAgentEnv({}, "session-1").PATH).toBe(binDir())
  })

  it("leaves PATH alone but still sets the session id when no shim exists", () => {
    const env = browserAgentEnv({ PATH: "/usr/bin" }, "session-1")
    expect(env.PATH).toBe("/usr/bin")
    expect(env.COGPIT_SESSION_ID).toBe("session-1")
  })

  it("overrides an inherited session id with the sentinel for a shared spawn", () => {
    writeShim()
    const env = browserAgentEnv({ PATH: "/usr/bin", COGPIT_SESSION_ID: "inherited" }, NO_COGPIT_SESSION)
    expect(env.COGPIT_SESSION_ID).toBe(NO_COGPIT_SESSION)
  })

  it("does not mutate the base environment", () => {
    writeShim()
    const base = { PATH: "/usr/bin" }
    browserAgentEnv(base, "session-1")
    expect(base).toEqual({ PATH: "/usr/bin" })
  })
})

describe("browserPluginPaths", () => {
  it("is empty until the plugin manifest exists", () => {
    expect(browserPluginPaths()).toEqual([])
  })

  it("points at the plugin directory once written", () => {
    ensurePlugin()
    expect(browserPluginPaths()).toEqual([pluginDir()])
  })
})
