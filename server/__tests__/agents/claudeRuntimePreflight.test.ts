// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  claudeCliPath: vi.fn<() => string | undefined>(),
  createSDKSession: vi.fn(),
  resumeSDKSession: vi.fn(),
}))
vi.mock("../../agents/claudeExecutable", () => ({ claudeCliPath: mocks.claudeCliPath }))
vi.mock("../../sdk-session", () => ({
  createSDKSession: mocks.createSDKSession,
  resumeSDKSession: mocks.resumeSDKSession,
  sdkSessions: new Map(),
  isSDKQueryLive: () => false,
}))

import { claudeRuntime } from "../../agents/claudeRuntime"
import { AGENT_NOT_INSTALLED } from "../../agents/spawnError"

const notInstalled = expect.objectContaining({
  code: AGENT_NOT_INSTALLED,
  message: expect.stringMatching(/^Claude Code isn't installed on this computer\.\nInstall it from https:\/\/code\.claude\.com\/docs\/en\/setup/),
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe("claudeRuntime without a Claude Code binary", () => {
  it("refuses to start in plain words instead of spawning the SDK", async () => {
    mocks.claudeCliPath.mockReturnValue(undefined)
    await expect(claudeRuntime.start({ cwd: "/work", dirName: "-work", message: "hi" })).rejects.toEqual(notInstalled)
    expect(mocks.createSDKSession).not.toHaveBeenCalled()
  })

  it("treats a configured path that no longer exists the same way", async () => {
    mocks.claudeCliPath.mockReturnValue("/nowhere/claude")
    await expect(claudeRuntime.send("11111111-1111-4111-8111-111111111111", { message: "hi" })).rejects.toEqual(notInstalled)
    expect(mocks.resumeSDKSession).not.toHaveBeenCalled()
  })
})
