// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { appendFile, open, readdir, stat, watch } = vi.hoisted(() => ({
  appendFile: vi.fn(),
  open: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  watch: vi.fn(),
}))

vi.mock("node:fs/promises", () => ({
  readdir,
  stat,
  open,
  appendFile,
}))

vi.mock("node:fs", () => ({ watch }))
vi.mock("../lib/activityMonitor", () => ({ recordActivity: vi.fn() }))

import { watchSubagents } from "../subagentWatcher"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function mockSource(readSource: () => Buffer, readSizes: number[] = []): void {
  stat.mockImplementation(async () => ({ size: readSource().length }))
  open.mockImplementation(async () => ({
    read: vi.fn(
      async (buffer: Buffer, _bufferOffset: number, length: number, position: number) => {
        readSizes.push(buffer.length)
        const source = readSource()
        const bytesRead = source.copy(buffer, 0, position, position + length)
        return { bytesRead }
      },
    ),
    close: vi.fn().mockResolvedValue(undefined),
  }))
}

function userLine(content: string): string {
  return JSON.stringify({
    type: "user",
    cwd: "/workspace",
    timestamp: "2026-07-21T00:00:00.000Z",
    message: { content },
  })
}

describe("watchSubagents", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    appendFile.mockResolvedValue(undefined)
    readdir.mockRejectedValue(new Error("missing"))
    watch.mockImplementation(() => { throw new Error("missing") })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it("uses a two-second fallback poll and stops it on close", async () => {
    const watcher = watchSubagents(
      "/tmp/session.jsonl",
      "session",
      new Map(),
    )

    expect(readdir).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(readdir).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(readdir).toHaveBeenCalledTimes(2)

    watcher.close()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(readdir).toHaveBeenCalledTimes(2)
  })

  it("retains an unterminated record and forwards it once the newline arrives", async () => {
    const line = userLine("delegate 🙂")
    let source = Buffer.from(line)
    readdir.mockResolvedValue(["agent-a.jsonl"])
    mockSource(() => source)
    const watcher = watchSubagents(
      "/tmp/session.jsonl",
      "session",
      new Map([["tool-1", "delegate 🙂"]]),
    )

    await vi.advanceTimersByTimeAsync(0)
    expect(appendFile).not.toHaveBeenCalled()

    source = Buffer.from(`${line}\n`)
    await vi.advanceTimersByTimeAsync(2_000)

    expect(appendFile).toHaveBeenCalledOnce()
    const progress = JSON.parse(String(appendFile.mock.calls[0][1]).trim())
    expect(progress.parentToolUseID).toBe("tool-1")
    expect(progress.data.message.message.content).toBe("delegate 🙂")
    watcher.close()
  })

  it("bounds large reads and preserves UTF-8 split across a chunk boundary", async () => {
    const chunkBytes = 256 * 1024
    const prefix = '{"type":"user","message":{"content":"'
    const suffix = '"}}'
    const filler = "a".repeat(chunkBytes - 1 - Buffer.byteLength(prefix))
    const content = `${filler}🙂`
    const source = Buffer.from(`${prefix}${content}${suffix}\n`)
    const readSizes: number[] = []
    readdir.mockResolvedValue(["agent-large.jsonl"])
    mockSource(() => source, readSizes)
    const watcher = watchSubagents(
      "/tmp/session.jsonl",
      "session",
      new Map([["tool-large", content]]),
    )

    await vi.advanceTimersByTimeAsync(0)

    expect(readSizes.length).toBeGreaterThan(1)
    expect(Math.max(...readSizes)).toBeLessThanOrEqual(chunkBytes)
    const progress = JSON.parse(String(appendFile.mock.calls[0][1]).trim())
    expect(progress.data.message.message.content).toBe(content)
    watcher.close()
  })

  it("coalesces a poll that fires while the previous scan is still pending", async () => {
    const firstScan = deferred<string[]>()
    readdir
      .mockReturnValueOnce(firstScan.promise)
      .mockResolvedValue([])
    const watcher = watchSubagents(
      "/tmp/session.jsonl",
      "session",
      new Map(),
    )

    expect(readdir).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(readdir).toHaveBeenCalledOnce()

    firstScan.resolve([])
    await vi.advanceTimersByTimeAsync(0)
    expect(readdir).toHaveBeenCalledTimes(2)
    watcher.close()
  })

  it("retries a complete record when appending it to the parent fails", async () => {
    const line = userLine("retry me")
    const source = Buffer.from(`${line}\n`)
    readdir.mockResolvedValue(["agent-retry.jsonl"])
    mockSource(() => source)
    appendFile
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined)
    const watcher = watchSubagents(
      "/tmp/session.jsonl",
      "session",
      new Map([["tool-retry", "retry me"]]),
    )

    await vi.advanceTimersByTimeAsync(0)
    expect(appendFile).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(appendFile).toHaveBeenCalledTimes(2)
    watcher.close()
  })
})
