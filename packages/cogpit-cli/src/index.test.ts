import { describe, expect, it, vi } from "vitest"
import {
  buildLaunchUrl,
  parseArgs,
  run,
  type CliDependencies,
  type LaunchCommand,
} from "./index"

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

function testDependencies(fetchImpl: typeof fetch) {
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
    io: {
      stdout: { write: (text) => stdout.push(text) },
      stderr: { write: (text) => stderr.push(text) },
    },
  }
  return { deps, stdout, stderr, openUrl, startServer, waitForShutdown, dispose }
}

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
