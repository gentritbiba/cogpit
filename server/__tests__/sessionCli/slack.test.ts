// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const service = vi.hoisted(() => ({
  addBot: vi.fn(async (name: string) => ({ name, botUserId: "U0BOT", teamId: "T1" })),
  removeBot: vi.fn(),
  bots: vi.fn(async () => []),
  link: vi.fn(async (options: { sessionId: string }) => ({ ...options })),
  unlink: vi.fn(async () => ({ unlinked: true, droppedPending: 0 })),
  status: vi.fn(async () => ({ links: [], bots: [] })),
  reply: vi.fn(async () => ({ posted: true })),
}))
vi.mock("../../slack", () => ({ slackService: () => service }))

import { PERSONAL_EDITION } from "../../edition"
import { slackCommand } from "../../sessionCli/slack"
import type { CliInvocation } from "../../sessionCli/commands"

let dir: string
beforeEach(async () => {
  vi.clearAllMocks()
  dir = await mkdtemp(join(tmpdir(), "cogpit-slack-cli-"))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const run = (argv: string[], overrides: Partial<CliInvocation> = {}) => slackCommand({
  argv: ["slack", ...argv],
  cwd: dir,
  invocationId: "i1",
  scope: "local",
  admin: true,
  visible: PERSONAL_EDITION.access.visibilityFor({} as never),
  callerSessionId: "s-caller",
  ...overrides,
}, argv)

describe("cogpit-session slack", () => {
  it("reads both tokens from a dotenv file and never prints them", async () => {
    await writeFile(join(dir, ".env"), "# odyssey\nSLACK_BOT_TOKEN=xoxb-1-secret\nexport SLACK_APP_TOKEN=\"xapp-1-secret\"\nOTHER=x\n")
    const output = await run(["bot", "add", "odyssey", "--env-file", ".env"])
    expect(output.exitCode).toBe(0)
    expect(service.addBot).toHaveBeenCalledWith("odyssey", "xoxb-1-secret", "xapp-1-secret")
    expect(output.stdout + output.stderr).not.toContain("secret")
  })

  it("needs both tokens", async () => {
    await writeFile(join(dir, "bot"), "xoxb-only\n")
    await expect(run(["bot", "add", "odyssey", "--bot-token-file", "bot"])).rejects.toThrow("needs both tokens")
  })

  it("links the calling session with the flags given", async () => {
    await run(["link", "--bot", "odyssey", "--allow", "U1,U2", "--channel", "C1", "--auto-post", "on", "--daily-cap", "5"])
    expect(service.link).toHaveBeenCalledWith({ sessionId: "s-caller", bot: "odyssey", allow: ["U1", "U2"], dms: undefined, channels: ["C1"], autoPost: true, dailyCap: 5 })
    await expect(run(["link", "--bot", "odyssey", "--auto-post", "maybe"])).rejects.toThrow("on or off")
  })

  it("keeps bots and other sessions' links for admins", async () => {
    await expect(run(["link", "--bot", "odyssey"], { admin: false })).rejects.toThrow("Only an admin")
    await expect(run(["reply", "--session", "s-other", "hi"], { admin: false })).rejects.toThrow("Only an admin")
    expect((await run(["unlink"], { admin: false })).exitCode).toBe(0)
  })

  it("replies as the calling session's link", async () => {
    await run(["reply", "--thread", "100.1", "all", "done"])
    expect(service.reply).toHaveBeenCalledWith("s-caller", { threadTs: "100.1", channel: undefined, text: "all done" })
    await expect(run(["reply", "hi"], { callerSessionId: undefined })).rejects.toThrow("run it from a Cogpit session")
  })
})
