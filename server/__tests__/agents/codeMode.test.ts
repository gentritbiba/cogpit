// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  spawned: vi.fn<(kind: string) => { path: string; source: "path" | "npm" | "bundled" | "custom" } | null>(),
  claudeDir: "/home/me/.claude",
}))
vi.mock("../../agents/executables", () => ({ spawnedExecutableFor: mocks.spawned }))
vi.mock("../../config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config")>()),
  getConfig: () => ({ claudeDir: mocks.claudeDir }),
}))
// The real one notes browser profiles under the user's home.
vi.mock("../../browser/agentEnv", () => ({
  cogpitAgentEnv: (base: NodeJS.ProcessEnv, sessionId: string) => ({ ...base, COGPIT_SESSION_ID: sessionId, PATH: `/cogpit/bin:${base.PATH ?? ""}` }),
}))

import { agentCodeModeLaunch, codeModeRequest } from "../../agents/codeMode"
import { instanceSessionId } from "../../../shared/session/instances"

const BUNDLED = "/app/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude"
const SESSION = "5b0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d"
const SETTINGS = ["--settings", "{\"autoCompactEnabled\":true}"]

function onPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!
  Object.defineProperty(process, "platform", { ...original, value: platform })
  try { return fn() } finally { Object.defineProperty(process, "platform", original) }
}

beforeEach(() => {
  mocks.spawned.mockImplementation((kind) => (kind === "claude" ? { path: BUNDLED, source: "bundled" } : null))
  // The CLI keeps its sessions where Cogpit reads them.
  vi.stubEnv("CLAUDE_CONFIG_DIR", "/home/me/.claude")
  mocks.claudeDir = "/home/me/.claude"
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("codeModeRequest", () => {
  it("reads a session for an agent with Code Mode", () => {
    expect(codeModeRequest({ agent: "claude", sessionId: SESSION, prompt: "fix it", model: "opus" })).toEqual({
      agent: "claude",
      sessionId: SESSION,
      resume: false,
      prompt: "fix it",
      model: "opus",
      effort: undefined,
      permissions: undefined,
    })
  })

  it("refuses an agent without Code Mode, an unknown agent and a session id that is not one", () => {
    expect(codeModeRequest({ agent: "codex", sessionId: SESSION })).toBeNull()
    expect(codeModeRequest({ agent: "rm -rf", sessionId: SESSION })).toBeNull()
    expect(codeModeRequest({ agent: "claude", sessionId: "--dangerously-skip-permissions" })).toBeNull()
    expect(codeModeRequest("claude")).toBeNull()
  })

  it("refuses a provider-account session, whose terminal would inherit the server's credentials", () => {
    expect(codeModeRequest({ agent: "claude", sessionId: instanceSessionId("work", SESSION) })).toBeNull()
  })

  it("drops values the CLI would read as flags", () => {
    const request = codeModeRequest({
      agent: "claude",
      sessionId: SESSION,
      resume: true,
      model: "--dangerously-skip-permissions",
      permissions: { mode: "acceptEdits", allowedTools: ["Read", "--bad"] },
    })
    expect(request).toMatchObject({ resume: true, model: undefined, permissions: { mode: "acceptEdits", allowedTools: ["Read"] } })
  })
})

describe("agentCodeModeLaunch", () => {
  it("starts a new session in Code Mode with the composer's choices and Cogpit's agent environment", () => {
    const launch = onPlatform("darwin", () => agentCodeModeLaunch(codeModeRequest({
      agent: "claude",
      sessionId: SESSION,
      prompt: "-starts with a dash",
      model: "opus",
      effort: "high",
      permissions: { mode: "acceptEdits" },
    })!))

    expect(launch.command).toBe(BUNDLED)
    expect(launch.args).toEqual([
      "--session-id", SESSION,
      "--model", "opus",
      "--effort", "high",
      "--permission-mode", "acceptEdits",
      ...SETTINGS,
      "--", "-starts with a dash",
    ])
    expect(launch.env).toMatchObject({
      CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: "1",
      COGPIT_SESSION_ID: SESSION,
      PATH: expect.stringMatching(/^\/cogpit\/bin:/),
    })
    // The terminal already starts from the server's environment; only what differs is sent.
    expect(launch.env).not.toHaveProperty("HOME")
  })

  it("keeps the tools denied outright under full access", () => {
    const launch = onPlatform("darwin", () => agentCodeModeLaunch(codeModeRequest({
      agent: "claude",
      sessionId: SESSION,
      permissions: { mode: "bypassPermissions", disallowedTools: ["Write"] },
    })!))
    expect(launch.args).toEqual(["--session-id", SESSION, "--dangerously-skip-permissions", "--disallowedTools", "Write", ...SETTINGS])
  })

  it("resumes without access flags when none were chosen, so the CLI's own default applies", () => {
    const launch = onPlatform("darwin", () => agentCodeModeLaunch(codeModeRequest({ agent: "claude", sessionId: SESSION, resume: true })!))
    expect(launch.args).toEqual(["--resume", SESSION, ...SETTINGS])
  })

  it("refuses a CLI whose sessions land outside the home Cogpit reads, before anything starts", () => {
    mocks.claudeDir = "/srv/elsewhere/.claude"
    expect(() => agentCodeModeLaunch(codeModeRequest({ agent: "claude", sessionId: SESSION })!))
      .toThrow("Claude Code keeps its sessions in /home/me/.claude, but Cogpit reads /srv/elsewhere/.claude")
  })
})
