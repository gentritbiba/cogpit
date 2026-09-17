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
    findSessionFile: async (id: string) => id === "native-thread" ? mocks.filePath : null,
    readIdentity: async () => ({ cwd: mocks.cwd }),
  }),
}))
vi.mock("../../agents/codexAppServer", () => ({
  codexAppServer: { startThread: mocks.startThread },
  CODEX_CLIENT_CAPABILITIES: { experimentalApi: false },
}))
vi.mock("../../agents/codexExecution", () => ({
  getCodexThreadIdentity: (thread: { id: string; path: string }) => ({
    sessionId: thread.id, filePath: thread.path, fileName: "2026/09/11/rollout-native-thread.jsonl",
  }),
  startCodexExecution: mocks.startThread,
  continueCodexExecution: mocks.continueThread,
  isCodexAppServerUnavailable: () => false,
}))
vi.mock("../../sessionPaths", () => ({ findNewestCodexSessionForCwd: mocks.findNewest }))
vi.mock("../../agents/tempImages", () => ({ writeTempImageFiles: async () => [], cleanupTempFiles: async () => {} }))
vi.mock("../../lib/binaryResolver", () => ({ resolveAgentCommand: (command: string, args: string[]) => ({ command, args }) }))
vi.mock("../../browser/agentEnv", () => ({ browserAgentEnv: (env: NodeJS.ProcessEnv) => env }))

import { codexRuntime } from "../../agents/codexRuntime"
import { activeProcesses, persistentSessions } from "../../processRegistry"

beforeEach(() => {
  vi.clearAllMocks()
  activeProcesses.clear()
  persistentSessions.clear()
})

describe("native worktree launch", () => {
  it.each([0, -1, 1.5, "1000000", Number.MAX_SAFE_INTEGER + 1])("rejects invalid context limits before launch: %s", async (value) => {
    await expect(codexRuntime.start({ dirName: "project", cwd: "/project", contextWindowTokens: value as number }))
      .rejects.toMatchObject({ status: 400 })
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(mocks.startThread).not.toHaveBeenCalled()
  })

  it("uses the native CLI and identifies the new checkout by the emitted thread id", async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 123, kill: vi.fn() })
    mocks.spawn.mockImplementation(() => {
      setTimeout(() => child.stdout.write('{"type":"thread.started","thread_id":"native-thread"}\n'), 0)
      return child
    })
    const descriptor = descriptorFor("codex")
    expect(descriptor.capabilities.worktrees).toBe(true)
    const result = await codexRuntime.start({
      dirName: descriptor.dirName.encode("/project"), cwd: "/project", message: "Build it",
      contextWindowTokens: 1000000, worktreeName: "build-it", permissions: { mode: "auto" },
    })

    expect(mocks.spawn).toHaveBeenCalledWith("codex", expect.arrayContaining(["-c", "model_context_window=1000000", "exec", "--json", "--enable", "worktrees", "--worktree", "--approve-for-me", "Build it"]), expect.objectContaining({ cwd: "/project" }))
    expect(mocks.startThread).not.toHaveBeenCalled()
    expect(mocks.findNewest).not.toHaveBeenCalled()
    expect(result).toMatchObject({ sessionId: "native-thread", dirName: descriptor.dirName.encode(mocks.cwd), filePath: mocks.filePath })
    expect(persistentSessions.has("native-thread")).toBe(true)
    child.emit("close", 0)
    child.stdout.end()
    child.stderr.end()
    await Promise.resolve()
    expect(persistentSessions.has("native-thread")).toBe(false)
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
