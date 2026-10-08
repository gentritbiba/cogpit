// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"

const mocks = vi.hoisted(() => ({ inputError: "EPIPE", commandError: false, callbackFirst: false }))
vi.mock("node:child_process", () => {
  const execFile = () => {}
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), { value: () => {
    const stdin = new EventEmitter() as EventEmitter & { end: (input: unknown, callback: (error?: Error) => void) => void }
    stdin.end = (_input, callback) => { queueMicrotask(() => {
      const error = Object.assign(new Error("Input pipe closed"), { code: mocks.inputError })
      if (mocks.callbackFirst) callback(error)
      stdin.emit("error", error)
    }) }
    const pending = Promise.resolve().then(() => {
      if (mocks.commandError) throw Object.assign(new Error("not a repository"), { code: 128, stderr: "not a repository" })
      return { stdout: "result", stderr: "" }
    })
    return Object.assign(pending, { child: { stdin } })
  } })
  return { execFile }
})
import { git, GitCommandError } from "../../workspaceTransfer/git"

beforeEach(() => { mocks.inputError = "EPIPE"; mocks.commandError = false; mocks.callbackFirst = false })
describe("Git input pipe closure", () => {
  it("accepts an early pipe close when the command has no input", async () => {
    await expect(git("/repo", ["rev-parse", "HEAD"])).resolves.toBe("result")
  })
  it("still reports the command's exit failure when its unused input pipe closes", async () => {
    mocks.commandError = true
    await expect(git("/repo", ["rev-parse", "HEAD"])).rejects.toMatchObject({ exitCode: 128, stderr: "not a repository" })
  })
  it("refuses a closed pipe that loses requested input", async () => {
    await expect(git("/repo", ["commit-tree", "tree"], { input: "Message" })).rejects.toBeInstanceOf(GitCommandError)
  })
  it("refuses payload loss when the end callback precedes the stream error", async () => {
    mocks.callbackFirst = true
    await expect(git("/repo", ["commit-tree", "tree"], { input: "Message" })).rejects.toBeInstanceOf(GitCommandError)
  })
  it("reports other input errors even without a payload", async () => {
    mocks.inputError = "EIO"
    await expect(git("/repo", ["rev-parse", "HEAD"])).rejects.toBeInstanceOf(GitCommandError)
  })
})
