import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  agentCliReport,
  buildLaunchUrl,
  packagedCoreBinary,
  parseArgs,
  run,
  USAGE,
  type CliDependencies,
  type LaunchCommand,
} from "./index"
import { quietSqliteWarning } from "./warnings"

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

function testDependencies(fetchImpl: typeof fetch, onPath: string[] = ["claude"]) {
  const stdout: string[] = []
  const stderr: string[] = []
  const openUrl = vi.fn(async () => {})
  const dispose = vi.fn(async () => {})
  const startServer = vi.fn(async () => ({
    host: "127.0.0.1",
    port: 43210,
    url: "http://127.0.0.1:43210",
    dataDir: "/tmp/cogpit",
    envPassword: false,
    dispose,
  }))
  const waitForShutdown = vi.fn(async () => {})
  const deps: CliDependencies = {
    fetch: fetchImpl,
    openUrl,
    startServer,
    waitForShutdown,
    findExecutable: (name) => onPath.includes(name) ? `/usr/local/bin/${name}` : undefined,
    io: {
      stdout: { write: (text) => stdout.push(text) },
      stderr: { write: (text) => stderr.push(text) },
    },
  }
  return { deps, stdout, stderr, openUrl, startServer, waitForShutdown, dispose }
}

describe("packagedCoreBinary", () => {
  function dist(...binaries: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "cogpit-cli-core-"))
    for (const binary of binaries) {
      mkdirSync(join(dir, "core", binary, ".."), { recursive: true })
      writeFileSync(join(dir, "core", binary), "")
    }
    return dir
  }

  it("picks the binary shipped for this platform", () => {
    const dir = dist("linux-arm64/cogpit-core", "win32-x64/cogpit-core.exe")
    try {
      expect(packagedCoreBinary(dir, "linux", "arm64")).toBe(join(dir, "core", "linux-arm64", "cogpit-core"))
      expect(packagedCoreBinary(dir, "win32", "x64")).toBe(join(dir, "core", "win32-x64", "cogpit-core.exe"))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("leaves a checkout, which ships no core, to its own build", () => {
    const dir = mkdtempSync(join(tmpdir(), "cogpit-cli-core-"))
    try {
      expect(packagedCoreBinary(dir, "linux", "x64")).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("says so when the package has no core for this platform", () => {
    const dir = dist("linux-x64/cogpit-core")
    try {
      expect(() => packagedCoreBinary(dir, "freebsd", "x64")).toThrow("no prebuilt core for freebsd-x64")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("Cogpit install-free CLI", () => {
  it("treats no arguments as a full Cogpit launch", () => {
    expect(parseArgs([])).toEqual({
      command: "launch",
      mode: "full",
      port: 0,
      noOpen: false,
    })
  })

  it("parses preview and local-server options", () => {
    expect(parseArgs([
      "preview",
      "session-123",
      "--port",
      "4312",
      "--data-dir",
      "./state",
      "--no-open",
    ])).toEqual({
      command: "launch",
      mode: "preview",
      sessionId: "session-123",
      port: 4312,
      dataDir: expect.stringMatching(/state$/),
      noOpen: true,
    })
  })

  it("rejects path-like session IDs", () => {
    expect(() => parseArgs(["preview", "../../secret"])).toThrow(
      "Session ID contains unsupported characters.",
    )
  })

  it("rejects incompatible embedded and external server options", () => {
    expect(() => parseArgs(["--server", "localhost:5173", "--port", "4312"]))
      .toThrow("--server and --port cannot be used together.")
  })

  it("builds full and preview URLs", () => {
    const full: LaunchCommand = {
      command: "launch",
      mode: "full",
      port: 0,
      noOpen: false,
    }
    expect(buildLaunchUrl("localhost:19384", full)).toBe("http://localhost:19384/")
    expect(buildLaunchUrl("localhost:19384", {
      ...full,
      mode: "preview",
      sessionId: "thread:123",
    })).toBe("http://localhost:19384/preview/thread%3A123")
  })

  it("starts an embedded server and opens full Cogpit by default", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(200, { app: "cogpit" }))
    const context = testDependencies(fetchImpl)

    await expect(run([], context.deps)).resolves.toBe(0)

    expect(context.startServer).toHaveBeenCalledWith({ port: 0, dataDir: undefined })
    expect(context.openUrl).toHaveBeenCalledWith("http://127.0.0.1:43210/")
    expect(context.waitForShutdown).toHaveBeenCalledOnce()
    expect(context.dispose).toHaveBeenCalledOnce()
    expect(context.stdout.join("")).toContain("Cogpit is running at http://127.0.0.1:43210/")
    expect(context.stderr).toEqual([])
  })

  it("says in --help that an agent CLI must be installed and signed in", async () => {
    const context = testDependencies(vi.fn<typeof fetch>())

    await expect(run(["--help"], context.deps)).resolves.toBe(0)

    expect(USAGE).toContain("Needs Claude Code, Codex or GitHub Copilot CLI installed and signed in.")
    expect(context.stdout.join("")).toBe(USAGE)
  })

  it("lists the agent CLIs it found and how to install the rest after starting", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(200, { app: "cogpit" }))
    const context = testDependencies(fetchImpl, ["claude"])

    await expect(run(["--no-open"], context.deps)).resolves.toBe(0)

    expect(context.stdout.join("")).toBe([
      "Cogpit is running at http://127.0.0.1:43210/",
      "",
      "Agent CLIs on this computer:",
      "  Claude Code         found",
      "  Codex               not found. Install: npm install -g @openai/codex",
      "  GitHub Copilot CLI  not found. Install: npm install -g @github/copilot",
      "To add another, install it, then run it once in a terminal to sign in.",
      "",
      "Press Ctrl+C to stop.",
      "",
    ].join("\n"))
  })

  it("tells a machine with no agent CLI that it needs one", () => {
    const report = agentCliReport(() => undefined)

    expect(report).toContain("  Claude Code         not found. Install: npm install -g @anthropic-ai/claude-code")
    expect(report).toContain("Cogpit needs at least one of these.")
  })

  it("adds no install advice once every agent CLI is present", () => {
    const report = agentCliReport((name) => `/bin/${name}`)

    expect(report).not.toContain("not found")
    expect(report).not.toContain("sign in")
  })

  it("starts an embedded server and preflights a preview session", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(200, { app: "cogpit" }))
      .mockResolvedValueOnce(response(200, { dirName: "project", fileName: "session-123.jsonl" }))
    const context = testDependencies(fetchImpl)

    await expect(run(["preview", "session-123"], context.deps)).resolves.toBe(0)

    expect(context.openUrl).toHaveBeenCalledWith(
      "http://127.0.0.1:43210/preview/session-123",
    )
    expect(context.dispose).toHaveBeenCalledOnce()
  })

  it("can explicitly reuse an already-running Cogpit server", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(200, { app: "cogpit" }))
      .mockResolvedValueOnce(response(200, { dirName: "project", fileName: "session-123.jsonl" }))
    const context = testDependencies(fetchImpl)

    await expect(run([
      "preview",
      "session-123",
      "--server",
      "http://127.0.0.1:5173",
    ], context.deps)).resolves.toBe(0)

    expect(context.startServer).not.toHaveBeenCalled()
    expect(context.openUrl).toHaveBeenCalledWith(
      "http://127.0.0.1:5173/preview/session-123",
    )
  })

  it("reports a missing preview and always shuts down its embedded server", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(200, { app: "cogpit" }))
      .mockResolvedValueOnce(response(404, { error: "Session not found" }))
    const context = testDependencies(fetchImpl)

    await expect(run([
      "preview",
      "missing",
      "--no-open",
    ], context.deps)).resolves.toBe(1)

    expect(context.stderr.join("")).toContain("Session missing was not found")
    expect(context.dispose).toHaveBeenCalledOnce()
    expect(context.waitForShutdown).not.toHaveBeenCalled()
  })
})

describe("quietSqliteWarning", () => {
  it("drops only Node's experimental SQLite warning", () => {
    const emitted: unknown[][] = []
    const target = { emitWarning: (...args: unknown[]) => { emitted.push(args) } }
    quietSqliteWarning(target)

    target.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning")
    target.emitWarning("SQLite is an experimental feature", { type: "ExperimentalWarning" })
    target.emitWarning("WASI is an experimental feature", "ExperimentalWarning")
    target.emitWarning("SQLite handle leaked", "Warning")
    target.emitWarning(new Error("Buffer() is deprecated"), "DeprecationWarning", "DEP0005")

    expect(emitted).toEqual([
      ["WASI is an experimental feature", "ExperimentalWarning"],
      ["SQLite handle leaked", "Warning"],
      [new Error("Buffer() is deprecated"), "DeprecationWarning", "DEP0005"],
    ])
  })
})
