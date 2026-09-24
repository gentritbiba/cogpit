// @vitest-environment node
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { createInterface } from "node:readline"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { descriptorFor } from "../../../shared/session/agent-descriptors"

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  findNewest: vi.fn(),
  startThread: vi.fn(),
  continueThread: vi.fn(),
  appServerUnavailable: vi.fn(() => false),
  filePath: "/codex/sessions/2026/09/11/rollout-native-thread.jsonl",
  cwd: "/codex/worktrees/abc/project",
}))

vi.mock("../../helpers", () => ({
  spawn: mocks.spawn,
  readFile: vi.fn(async () => "{\"type\":\"session_meta\"}\n"),
  unlink: vi.fn(),
  join: (...parts: string[]) => parts.join("/"),
  createInterface: (...args: Parameters<typeof createInterface>) => createInterface(...args),
}))
vi.mock("../../agents/index", () => ({
  storeFor: () => ({
    sessionsRoot: () => "/codex/sessions",
    listSessionFiles: async () => [],
    findSessionFile: async (id: string) => ANNOUNCED_THREADS.has(id) ? mocks.filePath : null,
    readIdentity: async () => ({ cwd: mocks.cwd }),
  }),
}))
vi.mock("../../agents/codexAppServer", () => ({
  codexAppServer: { startThread: mocks.startThread },
  CODEX_CLIENT_CAPABILITIES: { experimentalApi: false },
}))
vi.mock("../../agents/codexExecution", () => ({
  getCodexThreadIdentity: (thread: { id: string; path?: string }) => thread.path
    ? { sessionId: thread.id, filePath: thread.path, fileName: "2026/09/11/rollout-native-thread.jsonl" }
    : null,
  startCodexExecution: mocks.startThread,
  continueCodexExecution: mocks.continueThread,
  isCodexAppServerUnavailable: mocks.appServerUnavailable,
}))
vi.mock("../../sessionPaths", () => ({ findNewestCodexSessionForCwd: mocks.findNewest }))
vi.mock("../../agents/tempImages", () => ({ writeTempImageFiles: async () => [], cleanupTempFiles: async () => {} }))
vi.mock("../../lib/binaryResolver", () => ({ resolveAgentCommand: (command: string, args: string[]) => ({ command, args }) }))
vi.mock("../../browser/agentEnv", () => ({ browserAgentEnv: (env: NodeJS.ProcessEnv) => env }))
// "/project" is made up; resuming in a missing folder is covered in sessionCwd.test.ts.
vi.mock("../../lib/folders", () => ({ sessionFolderProblem: async () => null }))

import { codexRuntime } from "../../agents/codexRuntime"
import { activeProcesses, persistentSessions } from "../../processRegistry"

/** Thread ids whose rollout the fake store can find. */
const ANNOUNCED_THREADS = new Set(["native-thread", "app-thread", "cli-thread"])

beforeEach(() => {
  vi.resetAllMocks()
  activeProcesses.clear()
  persistentSessions.clear()
})

/** A `codex exec` child that prints `lines` to stdout once it is spawned. */
function spawnCli(...lines: unknown[]) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 123, kill: vi.fn() })
  const print = (line: unknown) => child.stdout.write(`${JSON.stringify(line)}\n`)
  mocks.spawn.mockImplementation(() => {
    setTimeout(() => { for (const line of lines) print(line) }, 0)
    return child
  })
  return {
    print,
    async exit(code = 0) {
      child.emit("close", code)
      child.stdout.end()
      child.stderr.end()
      await Promise.resolve()
    },
  }
}

/** The app-server cannot run at all, so the start falls back to the CLI before any thread exists. */
function appServerMissing(): void {
  mocks.startThread.mockRejectedValueOnce(Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }))
  mocks.appServerUnavailable.mockReturnValueOnce(true)
}

const cliSessionMeta = {
  type: "session_meta",
  payload: { id: "cli-thread", timestamp: "2026-09-22T10:00:00.000Z", cwd: "/project" },
}

describe("native worktree launch", () => {
  it.each([0, -1, 1.5, "1000000", Number.MAX_SAFE_INTEGER + 1])("rejects invalid context limits before launch: %s", async (value) => {
    await expect(codexRuntime.start({ dirName: "project", cwd: "/project", contextWindowTokens: value as number }))
      .rejects.toMatchObject({ status: 400 })
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(mocks.startThread).not.toHaveBeenCalled()
  })

  it("uses the native CLI and identifies the new checkout by the emitted thread id", async () => {
    const cli = spawnCli({ type: "thread.started", thread_id: "native-thread" })
    const descriptor = descriptorFor("codex")
    expect(descriptor.capabilities.worktrees).toBe(true)
    const onSessionId = vi.fn()
    const result = await codexRuntime.start({
      dirName: descriptor.dirName.encode("/project"), cwd: "/project", message: "Build it",
      contextWindowTokens: 1000000, worktreeName: "build-it", permissions: { mode: "auto" }, onSessionId,
    })

    expect(mocks.spawn).toHaveBeenCalledWith("codex", expect.arrayContaining(["-c", "model_context_window=1000000", "exec", "--json", "--enable", "worktrees", "--worktree", "--approve-for-me", "Build it"]), expect.objectContaining({ cwd: "/project" }))
    expect(mocks.startThread).not.toHaveBeenCalled()
    expect(mocks.findNewest).not.toHaveBeenCalled()
    expect(result).toMatchObject({ sessionId: "native-thread", dirName: descriptor.dirName.encode(mocks.cwd), filePath: mocks.filePath })
    expect(onSessionId.mock.calls).toEqual([["native-thread"]])
    expect(persistentSessions.has("native-thread")).toBe(true)
    await cli.exit()
    expect(persistentSessions.has("native-thread")).toBe(false)
  })
})

describe("CLI fallback", () => {
  it("starts on the CLI when the app-server fails before any thread exists, reporting the CLI's session once", async () => {
    appServerMissing()
    const cli = spawnCli(cliSessionMeta)
    const onSessionId = vi.fn()

    const result = await codexRuntime.start({ dirName: "project", cwd: "/project", message: "Build", onSessionId })

    expect(result.sessionId).toBe("cli-thread")
    expect(onSessionId.mock.calls).toEqual([["cli-thread"]])
    await cli.exit()
  })

  it("reports the thread the CLI announced even when the start then fails", async () => {
    appServerMissing()
    const cli = spawnCli({ type: "thread.started", thread_id: "unwritten-thread" })
    const onSessionId = vi.fn()

    const start = codexRuntime.start({ dirName: "project", cwd: "/project", message: "Build", onSessionId })
    await vi.waitFor(() => expect(onSessionId).toHaveBeenCalled())
    await cli.exit(1)

    await expect(start).rejects.toMatchObject({ status: 500 })
    expect(onSessionId.mock.calls).toEqual([["unwritten-thread"]])
  })

  it("leaves a session it only recognised by scanning the working directory unreported", async () => {
    vi.useFakeTimers()
    try {
      appServerMissing()
      const cli = spawnCli()
      mocks.findNewest.mockResolvedValue({ sessionId: "scanned-thread", filePath: mocks.filePath, fileName: "scanned.jsonl" })
      const onSessionId = vi.fn()

      const start = codexRuntime.start({ dirName: "project", cwd: "/project", message: "Build", onSessionId })
      await vi.runAllTimersAsync()

      expect((await start).sessionId).toBe("scanned-thread")
      expect(onSessionId).not.toHaveBeenCalled()
      await cli.exit()
    } finally {
      vi.useRealTimers()
    }
  })

  it("reports a rollout it found by scanning once the CLI announces it", async () => {
    appServerMissing()
    const cli = spawnCli()
    mocks.findNewest.mockResolvedValue({ sessionId: "cli-thread", filePath: mocks.filePath, fileName: "scanned.jsonl" })
    const onSessionId = vi.fn()

    const start = codexRuntime.start({ dirName: "project", cwd: "/project", message: "Build", onSessionId })
    await vi.waitFor(() => expect(mocks.findNewest).toHaveBeenCalled())
    cli.print({ type: "thread.started", thread_id: "cli-thread" })

    expect((await start).sessionId).toBe("cli-thread")
    expect(onSessionId.mock.calls).toEqual([["cli-thread"]])
    await cli.exit()
  })

  it("takes the thread the CLI announced over another start's rollout found by scanning", async () => {
    appServerMissing()
    const cli = spawnCli()
    mocks.findNewest.mockResolvedValue({ sessionId: "concurrent-thread", filePath: "/elsewhere.jsonl", fileName: "elsewhere.jsonl" })
    const onSessionId = vi.fn()

    const start = codexRuntime.start({ dirName: "project", cwd: "/project", message: "Build", onSessionId })
    await vi.waitFor(() => expect(mocks.findNewest).toHaveBeenCalled())
    cli.print({ type: "thread.started", thread_id: "cli-thread" })

    expect((await start).sessionId).toBe("cli-thread")
    expect(onSessionId.mock.calls).toEqual([["cli-thread"]])
    await cli.exit()
  })

  it("still starts when the caller's onSessionId throws", async () => {
    appServerMissing()
    const cli = spawnCli(cliSessionMeta)
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const result = await codexRuntime.start({
        dirName: "project",
        cwd: "/project",
        message: "Build",
        onSessionId: () => { throw new Error("owner store unavailable") },
      })
      expect(result.sessionId).toBe("cli-thread")
      expect(logged).toHaveBeenCalled()
    } finally {
      logged.mockRestore()
      await cli.exit()
    }
  })
})

describe("app-server launch", () => {
  it("reports the started thread once and never falls back to a second session after it", async () => {
    const onSessionId = vi.fn()
    mocks.startThread.mockImplementationOnce(
      async (_client: unknown, _options: unknown, onThreadStarted: (threadId: string) => void) => {
        onThreadStarted("app-thread")
        throw new Error("turn/start is not supported")
      },
    )
    mocks.appServerUnavailable.mockReturnValueOnce(true)

    await expect(codexRuntime.start({ dirName: "project", cwd: "/project", message: "Build", onSessionId }))
      .rejects.toMatchObject({ status: 500 })

    expect(onSessionId.mock.calls).toEqual([["app-thread"]])
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it("finds a thread's rollout by its id, never by scanning the working directory", async () => {
    const onSessionId = vi.fn()
    mocks.startThread.mockImplementationOnce(
      async (_client: unknown, _options: unknown, onThreadStarted: (threadId: string) => void) => {
        onThreadStarted("app-thread")
        return { thread: { id: "app-thread" }, turnId: "turn-1" }
      },
    )
    mocks.findNewest.mockResolvedValue({ sessionId: "concurrent-thread", filePath: "/elsewhere.jsonl", fileName: "elsewhere.jsonl" })

    const result = await codexRuntime.start({ dirName: "project", cwd: "/project", message: "Build", onSessionId })

    expect(result.sessionId).toBe("app-thread")
    expect(onSessionId.mock.calls).toEqual([["app-thread"]])
    expect(mocks.findNewest).not.toHaveBeenCalled()
  })
})

describe("context limit changes on existing threads", () => {
  it("reloads only changed limits and keeps changes pending while a turn is steered", async () => {
    mocks.startThread.mockResolvedValue({ thread: { id: "context-thread", path: mocks.filePath }, turnId: "first" })
    mocks.continueThread.mockResolvedValue({ action: "started", turnId: "next" })
    await codexRuntime.start({ dirName: "project", cwd: "/project", contextWindowTokens: 200000 })
    await codexRuntime.send("context-thread", { cwd: "/project", message: "same", contextWindowTokens: 200000 })
    expect(mocks.continueThread).toHaveBeenLastCalledWith(expect.anything(), "context-thread", expect.objectContaining({ reloadContextWindow: false }))
    mocks.continueThread.mockResolvedValueOnce({ action: "steered", turnId: "next" })
    await codexRuntime.send("context-thread", { cwd: "/project", message: "steer", contextWindowTokens: 1000000 })
    await codexRuntime.send("context-thread", { cwd: "/project", message: "apply", contextWindowTokens: 1000000 })
    expect(mocks.continueThread).toHaveBeenLastCalledWith(expect.anything(), "context-thread", expect.objectContaining({ contextWindowTokens: 1000000, reloadContextWindow: true }))
    await codexRuntime.send("context-thread", { cwd: "/project", message: "reset", contextWindowTokens: null })
    expect(mocks.continueThread).toHaveBeenLastCalledWith(expect.anything(), "context-thread", expect.objectContaining({ contextWindowTokens: null, reloadContextWindow: true }))
  })
})
