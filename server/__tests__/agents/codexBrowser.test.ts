// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { codexBrowserConfig } from "../../agents/codexBrowser"
import { BROWSER_CONTEXT_APPEND } from "../../browser/agentContext"
import { binDir, shimPath } from "../../browser/paths"

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cogpit-browser-config-"))
  vi.stubEnv("COGPIT_BROWSER_HOME", join(root, "browser"))
  vi.stubEnv("PATH", "/ordinary/bin")
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

function installShim() {
  mkdirSync(binDir(), { recursive: true })
  writeFileSync(shimPath(), "#!/bin/sh\n", { mode: 0o755 })
}

describe("Codex browser configuration", () => {
  const client = { call: vi.fn() }

  beforeEach(() => { client.call.mockReset().mockResolvedValue({ config: {} }) })

  it("does not advertise or configure an unavailable browser", async () => {
    expect(await codexBrowserConfig(client, root)).toEqual({})
    expect(client.call).not.toHaveBeenCalled()
  })

  it("reapplies the managed PATH after shell snapshots and supplies guidance without a skill", async () => {
    installShim()
    expect(await codexBrowserConfig(client, root)).toEqual({
      "shell_environment_policy.set.PATH": `${binDir()}${delimiter}/ordinary/bin`,
      "shell_environment_policy.set.COGPIT_SESSION_ID": "",
      developer_instructions: BROWSER_CONTEXT_APPEND,
    })
    expect(client.call).toHaveBeenCalledWith("config/read", { cwd: root })
    expect(process.env.PATH).toBe("/ordinary/bin")
  })

  it("uses the resumed identity instead of inheriting another session", async () => {
    installShim()
    vi.stubEnv("COGPIT_SESSION_ID", "wrong-session")
    expect((await codexBrowserConfig(client, root, "resumed-session"))["shell_environment_policy.set.COGPIT_SESSION_ID"]).toBe("resumed-session")
    expect((await codexBrowserConfig(client, root))["shell_environment_policy.set.COGPIT_SESSION_ID"]).toBe("")
  })

  it("preserves configured instructions and custom tool paths", async () => {
    installShim()
    client.call.mockResolvedValue({ config: {
      developer_instructions: "Keep the user's custom instructions.",
      shell_environment_policy: { set: { PATH: "/custom/tools:/usr/bin", KEEP_ME: "yes" } },
    } })
    const config = await codexBrowserConfig(client, root)
    expect(config.developer_instructions).toBe(`Keep the user's custom instructions.\n\n${BROWSER_CONTEXT_APPEND}`)
    expect(config["shell_environment_policy.set.PATH"]).toBe(`${binDir()}${delimiter}/custom/tools:/usr/bin`)
    expect(config).not.toHaveProperty("shell_environment_policy.set")
  })

  it("does not silently replace instructions if effective config cannot be read", async () => {
    installShim()
    client.call.mockRejectedValue(new Error("config unavailable"))
    await expect(codexBrowserConfig(client, root)).rejects.toThrow("config unavailable")
  })
})
