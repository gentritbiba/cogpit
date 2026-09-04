// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  runCli: vi.fn(),
  findExecutableOnPath: vi.fn(),
}))
vi.mock("../../lib/cliProcess", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/cliProcess")>()),
  runCli: mocks.runCli,
}))
vi.mock("../../lib/binaryResolver", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/binaryResolver")>()),
  findExecutableOnPath: mocks.findExecutableOnPath,
}))

import {
  CSWAP_BIN,
  describeClaudeAccounts,
  parseAccountList,
  parseSwitchResult,
  switchClaudeAccount,
} from "../../agents/claudeSwap"

const LIST = {
  schemaVersion: 1,
  activeAccountNumber: 2,
  accounts: [
    {
      number: 1,
      email: "work@example.com",
      organizationName: "Work Org",
      organizationUuid: "org-1",
      isOrganization: true,
      active: false,
      usageStatus: "ok",
      usage: {
        fiveHour: { pct: 50, resetsAt: "2026-09-04T15:20:00Z", countdown: "33m", clock: "17:20" },
        sevenDay: { pct: 79, resetsAt: "2026-09-08T22:00:00Z", countdown: "4d 7h", expectedPct: 38.6 },
        scoped: [{ pct: 71, name: "Fable" }],
      },
      alias: "work",
      usageFetchedAt: "2026-09-04T14:46:54Z",
      usageAgeSeconds: 0,
    },
    {
      number: 2,
      email: "me@example.com",
      organizationName: "",
      organizationUuid: "",
      isOrganization: false,
      active: true,
      usageStatus: "token_expired",
      usage: null,
      disabled: true,
    },
  ],
}

function ok(stdout: string) {
  return { code: 0, stdout, stderr: "", timedOut: false }
}

describe("parseAccountList", () => {
  it("projects the switcher's rows onto the account contract", () => {
    expect(parseAccountList(JSON.stringify(LIST))).toEqual({
      activeSlot: 2,
      accounts: [
        {
          slot: 1,
          alias: "work",
          email: "work@example.com",
          organization: "Work Org",
          active: false,
          disabled: false,
          usageStatus: "ok",
          usage: {
            fiveHour: { pct: 50, resetsIn: "33m", resetsAt: "2026-09-04T15:20:00Z" },
            sevenDay: { pct: 79, resetsIn: "4d 7h", resetsAt: "2026-09-08T22:00:00Z" },
          },
        },
        {
          slot: 2,
          alias: null,
          email: "me@example.com",
          organization: null,
          active: true,
          disabled: true,
          usageStatus: "token_expired",
          usage: null,
        },
      ],
    })
  })

  it("never forwards fields outside the contract", () => {
    const list = JSON.stringify({
      ...LIST,
      accounts: [{ ...LIST.accounts[0], accessToken: "secret", refreshToken: "secret" }],
    })
    expect(JSON.stringify(parseAccountList(list))).not.toContain("secret")
  })

  it("drops rows without a numeric slot and email, and tolerates missing fields", () => {
    const list = JSON.stringify({
      accounts: [
        { number: "3", email: "bad@example.com" },
        { number: 4 },
        { number: 5, email: "sparse@example.com", usage: { fiveHour: { pct: "high" } } },
      ],
    })
    expect(parseAccountList(list)).toEqual({
      activeSlot: null,
      accounts: [{
        slot: 5,
        alias: null,
        email: "sparse@example.com",
        organization: null,
        active: false,
        disabled: false,
        usageStatus: "unavailable",
        usage: { fiveHour: null, sevenDay: null },
      }],
    })
  })

  it("returns null for malformed output", () => {
    expect(parseAccountList("not json")).toBeNull()
    expect(parseAccountList("[]")).toBeNull()
    expect(parseAccountList(JSON.stringify({ accounts: "nope" }))).toBeNull()
  })
})

describe("parseSwitchResult", () => {
  it("reads a completed switch", () => {
    const out = JSON.stringify({
      schemaVersion: 1,
      switched: true,
      from: { number: 2, email: "me@example.com" },
      to: { number: 1, email: "work@example.com" },
      message: "Switched to Account-1 (work@example.com)",
      warnings: ["stale lock removed"],
    })
    expect(parseSwitchResult(out)).toEqual({
      switched: true,
      message: "Switched to Account-1 (work@example.com)",
      warnings: ["stale lock removed"],
    })
  })

  it("surfaces the switcher's error envelope", () => {
    const out = JSON.stringify({ schemaVersion: 1, error: { type: "ValidationError", message: "No such account" } })
    expect(parseSwitchResult(out)).toEqual({ error: "No such account" })
  })

  it("returns null for anything else", () => {
    expect(parseSwitchResult("")).toBeNull()
    expect(parseSwitchResult(JSON.stringify({ switched: "yes" }))).toBeNull()
  })
})

describe("describeClaudeAccounts", () => {
  beforeEach(() => {
    mocks.runCli.mockReset()
    mocks.findExecutableOnPath.mockReset()
  })

  it("reports missing without spawning anything when the tool is not on PATH", async () => {
    mocks.findExecutableOnPath.mockReturnValue(undefined)
    await expect(describeClaudeAccounts()).resolves.toEqual({ status: "missing" })
    expect(mocks.findExecutableOnPath).toHaveBeenCalledWith(CSWAP_BIN)
    expect(mocks.runCli).not.toHaveBeenCalled()
  })

  it("lists accounts and the tool version when installed", async () => {
    mocks.findExecutableOnPath.mockReturnValue("/Users/me/.local/bin/cswap")
    mocks.runCli.mockImplementation((_bin: string, args: string[]) =>
      Promise.resolve(ok(args[0] === "--version" ? "cswap 0.26.0\n" : JSON.stringify(LIST))))

    const report = await describeClaudeAccounts()

    expect(report).toMatchObject({ status: "ok", tool: "claude-swap", version: "0.26.0", activeSlot: 2 })
    expect(report.status === "ok" && report.accounts.map((a) => a.slot)).toEqual([1, 2])
    expect(mocks.runCli).toHaveBeenCalledWith(CSWAP_BIN, ["list", "--json"], expect.any(Number))
  })

  it("reports the switcher's own error when listing fails", async () => {
    mocks.findExecutableOnPath.mockReturnValue("/Users/me/.local/bin/cswap")
    mocks.runCli.mockImplementation((_bin: string, args: string[]) =>
      Promise.resolve(args[0] === "--version"
        ? ok("cswap 0.26.0")
        : { code: 1, stdout: JSON.stringify({ error: { message: "No accounts are managed yet" } }), stderr: "", timedOut: false }))

    await expect(describeClaudeAccounts()).resolves.toEqual({ status: "error", error: "No accounts are managed yet" })
  })

  it("reports malformed list output as an error", async () => {
    mocks.findExecutableOnPath.mockReturnValue("/Users/me/.local/bin/cswap")
    mocks.runCli.mockResolvedValue(ok("<html>oops</html>"))

    const report = await describeClaudeAccounts()
    expect(report.status).toBe("error")
    expect(report.status === "error" && report.error).toMatch(/unexpected output/i)
  })
})

describe("switchClaudeAccount", () => {
  beforeEach(() => { mocks.runCli.mockReset() })

  it("switches by numeric slot with an argv array", async () => {
    mocks.runCli.mockResolvedValue(ok(JSON.stringify({
      switched: true, message: "Switched to Account-1 (work@example.com)", warnings: [],
    })))

    const result = await switchClaudeAccount(1)

    expect(mocks.runCli).toHaveBeenCalledWith(CSWAP_BIN, ["switch", "1", "--json"], expect.any(Number))
    expect(result).toEqual({
      switched: true,
      message: "Switched to Account-1 (work@example.com)",
      warnings: [],
      credentialStore: process.platform === "darwin" ? "keychain" : "file",
    })
  })

  it("rejects slots that are not positive integers before spawning", async () => {
    for (const slot of [0, -1, 1.5, Number.NaN]) {
      await expect(switchClaudeAccount(slot)).rejects.toThrow(/slot/)
    }
    expect(mocks.runCli).not.toHaveBeenCalled()
  })

  it("throws the switcher's error message on failure", async () => {
    mocks.runCli.mockResolvedValue({
      code: 1,
      stdout: JSON.stringify({ error: { type: "ConfigError", message: "Account 9 not found" } }),
      stderr: "",
      timedOut: false,
    })
    await expect(switchClaudeAccount(9)).rejects.toThrow("Account 9 not found")
  })

  it("falls back to stderr when the failure is not a JSON envelope", async () => {
    mocks.runCli.mockResolvedValue({ code: 1, stdout: "", stderr: "Traceback: boom", timedOut: false })
    await expect(switchClaudeAccount(1)).rejects.toThrow("Traceback: boom")
  })

  it("reports a timeout distinctly", async () => {
    mocks.runCli.mockResolvedValue({ code: null, stdout: "", stderr: "", timedOut: true })
    await expect(switchClaudeAccount(1)).rejects.toThrow(/timed out/)
  })
})
