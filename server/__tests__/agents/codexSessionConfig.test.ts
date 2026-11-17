// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { codexSessionConfig } from "../../agents/codexSessionConfig"
import { MEDIA_CONTEXT_APPEND } from "../../agents/replyContext"
import { BROWSER_CONTEXT_APPEND } from "../../browser/agentContext"
import { binDir, shimPath } from "../../browser/paths"
import { resetServerPortForTest, setServerPort } from "../../lib/portFile"

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cogpit-codex-config-"))
  vi.stubEnv("COGPIT_BROWSER_HOME", join(root, "browser"))
  vi.stubEnv("PATH", "/ordinary/bin")
  // An agent Cogpit started inherits one; the expectations below assume none.
  vi.stubEnv("COGPIT_PORT", undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

function installShim() {
  mkdirSync(binDir(), { recursive: true })
  writeFileSync(shimPath(), "#!/bin/sh\n", { mode: 0o755 })
}

describe("Codex session configuration", () => {
  const client = { call: vi.fn() }

  beforeEach(() => { client.call.mockReset().mockResolvedValue({ config: {} }) })

  it("only adds the media guidance when no Cogpit tools are installed", async () => {
    expect(await codexSessionConfig(client, root)).toEqual({ developer_instructions: MEDIA_CONTEXT_APPEND })
    expect(client.call).toHaveBeenCalledWith("config/read", { cwd: root })
  })

  it("reapplies the managed PATH after shell snapshots and supplies guidance without a skill", async () => {
    installShim()
    expect(await codexSessionConfig(client, root)).toEqual({
      "shell_environment_policy.set.PATH": `${binDir()}${delimiter}/ordinary/bin`,
      "shell_environment_policy.set.COGPIT_SESSION_ID": "",
      developer_instructions: `${MEDIA_CONTEXT_APPEND}\n\n${BROWSER_CONTEXT_APPEND}`,
    })
    expect(client.call).toHaveBeenCalledWith("config/read", { cwd: root })
    expect(process.env.PATH).toBe("/ordinary/bin")
  })

  it("uses the resumed identity instead of inheriting another session", async () => {
    installShim()
    vi.stubEnv("COGPIT_SESSION_ID", "wrong-session")
    expect((await codexSessionConfig(client, root, "resumed-session"))["shell_environment_policy.set.COGPIT_SESSION_ID"]).toBe("resumed-session")
    expect((await codexSessionConfig(client, root))["shell_environment_policy.set.COGPIT_SESSION_ID"]).toBe("")
  })

  it("preserves configured instructions and custom tool paths", async () => {
    installShim()
    client.call.mockResolvedValue({ config: {
      developer_instructions: "Keep the user's custom instructions.",
      shell_environment_policy: { set: { PATH: "/custom/tools:/usr/bin", KEEP_ME: "yes" } },
    } })
    const config = await codexSessionConfig(client, root)
    expect(config.developer_instructions).toBe(`Keep the user's custom instructions.\n\n${MEDIA_CONTEXT_APPEND}\n\n${BROWSER_CONTEXT_APPEND}`)
    expect(config["shell_environment_policy.set.PATH"]).toBe(`${binDir()}${delimiter}/custom/tools:/usr/bin`)
    expect(config).not.toHaveProperty("shell_environment_policy.set")
  })

  it("still puts the session CLI on PATH when agent-browser is not installed", async () => {
    mkdirSync(binDir(), { recursive: true })
    expect(await codexSessionConfig(client, root, "thread-1")).toEqual({
      "shell_environment_policy.set.PATH": `${binDir()}${delimiter}/ordinary/bin`,
      "shell_environment_policy.set.COGPIT_SESSION_ID": "thread-1",
      developer_instructions: MEDIA_CONTEXT_APPEND,
    })
  })

  it("tells the thread which port this server listens on", async () => {
    installShim()
    setServerPort(19999)
    try {
      expect((await codexSessionConfig(client, root))["shell_environment_policy.set.COGPIT_PORT"]).toBe("19999")
    } finally {
      resetServerPortForTest()
    }
  })

  it("does not silently replace instructions if effective config cannot be read", async () => {
    installShim()
    client.call.mockRejectedValue(new Error("config unavailable"))
    await expect(codexSessionConfig(client, root)).rejects.toThrow("config unavailable")
  })
})
