// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SessionCreationRequests } from "../../lib/sessionCreationRequests"

const request = { dirName: "-tmp-project", cwd: "/tmp/project", message: "Extract the design" }
const result = { sessionId: "created", dirName: request.dirName, fileName: "created.jsonl", filePath: "/tmp/created.jsonl" }

describe("session creation retries", () => {
  let directory: string
  let requests: SessionCreationRequests

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cogpit-creation-"))
    requests = new SessionCreationRequests(() => directory)
  })
  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

  it("runs concurrent retries once and replays after a server restart", async () => {
    const start = vi.fn(async () => result)
    const responses = await Promise.all(Array.from({ length: 5 }, () =>
      requests.run("user-1", "request-123", request, start)))
    expect(responses).toEqual(Array(5).fill(result))
    expect(start).toHaveBeenCalledTimes(1)
    const restarted = new SessionCreationRequests(() => directory)
    await expect(restarted.run("user-1", "request-123", request, start)).resolves.toEqual(result)
    expect(start).toHaveBeenCalledTimes(1)
  })

  it("rejects a changed payload both during and after creation", async () => {
    let finish!: (value: typeof result) => void
    const first = requests.run("user-1", "request-123", request, () => new Promise((resolve) => { finish = resolve }))
    const changed = { ...request, message: "Different task" }
    await expect(requests.run("user-1", "request-123", changed, vi.fn())).rejects.toMatchObject({ status: 409 })
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"))
    finish(result)
    await first
    await expect(requests.run("user-1", "request-123", changed, vi.fn())).rejects.toMatchObject({ status: 409 })
  })

  it("compares JSON objects independently of property order", async () => {
    const start = vi.fn(async () => result)
    await requests.run("user-1", "request-123", request, start)
    await requests.run("user-1", "request-123", { message: request.message, cwd: request.cwd, dirName: request.dirName }, start)
    expect(start).toHaveBeenCalledTimes(1)
  })

  it("isolates users and distinct request IDs", async () => {
    const start = vi.fn(async () => result)
    await requests.run("user-1", "request-123", request, start)
    await requests.run("user-2", "request-123", request, start)
    await requests.run("user-1", "request-456", request, start)
    expect(start).toHaveBeenCalledTimes(3)
  })

  it("does not spawn again after an ambiguous failure", async () => {
    const start = vi.fn().mockRejectedValue(new Error("transport lost after spawn"))
    await expect(requests.run("user-1", "request-123", request, start)).rejects.toThrow("transport lost")
    const restarted = new SessionCreationRequests(() => directory)
    await expect(restarted.run("user-1", "request-123", request, start)).rejects.toMatchObject({ status: 409 })
    expect(start).toHaveBeenCalledTimes(1)
    const [file] = await readdir(directory)
    expect(await readFile(join(directory, file), "utf8")).not.toContain(request.message)
  })

  it("blocks another server while creation is in progress", async () => {
    let finish!: (value: typeof result) => void
    const first = requests.run("user-1", "request-123", request, () => new Promise((resolve) => { finish = resolve }))
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"))
    const other = new SessionCreationRequests(() => directory)
    const start = vi.fn()
    await expect(other.run("user-1", "request-123", request, start)).rejects.toMatchObject({ status: 409 })
    expect(start).not.toHaveBeenCalled()
    finish(result)
    await first
    await expect(other.run("user-1", "request-123", request, start)).resolves.toEqual(result)
  })

  it.each(["", "../escape", 42, null, "x".repeat(129)])("rejects invalid requestId %s", async (id) => {
    const start = vi.fn()
    await expect(requests.run("user-1", id, request, start)).rejects.toMatchObject({ status: 400 })
    expect(start).not.toHaveBeenCalled()
    expect(await readdir(directory)).toEqual([])
  })
})
