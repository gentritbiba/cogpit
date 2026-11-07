// @vitest-environment node
import { basename } from "node:path"
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

import { watchSubagents, type SubagentTask } from "../subagentWatcher"

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

/** Serve a distinct body per agent file, keyed by file name. */
function mockFiles(files: Record<string, string>): void {
  const buffers = new Map(Object.entries(files).map(([name, body]) => [name, Buffer.from(body)]))
  // The watcher builds each path with join(), which emits backslashes on
  // Windows, so the base name has to be taken platform-natively.
  const bufferFor = (p: string): Buffer => buffers.get(basename(p)) ?? Buffer.alloc(0)
  readdir.mockResolvedValue([...buffers.keys()])
  stat.mockImplementation(async (p: string) => ({ size: bufferFor(p).length }))
  open.mockImplementation(async (p: string) => ({
    read: vi.fn(
      async (buffer: Buffer, _bufferOffset: number, length: number, position: number) => {
        const bytesRead = bufferFor(p).copy(buffer, 0, position, position + length)
        return { bytesRead }
      },
    ),
    close: vi.fn().mockResolvedValue(undefined),
  }))
}

function tasks(entries: Record<string, Omit<SubagentTask, "forwardedBytes">>): Map<string, SubagentTask> {
  return new Map(Object.entries(entries).map(([taskId, task]) => [taskId, { ...task, forwardedBytes: 0 }]))
}

/** agentId → parentToolUseID across every synthesized progress entry. */
function forwardedAttribution(): Map<string, string> {
  const seen = new Map<string, string>()
  for (const call of appendFile.mock.calls) {
    const entry = JSON.parse(String(call[1]).trim())
    seen.set(entry.data.agentId, entry.parentToolUseID)
  }
  return seen
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

  it("uses file events and a slow backstop once the directory can be watched", async () => {
    const close = vi.fn()
    const on = vi.fn()
    let changed!: () => void
    watch.mockImplementation((_path, _options, callback) => {
      changed = callback
      return { close, on }
    })
    readdir.mockResolvedValue([])
    const watcher = watchSubagents("/tmp/session.jsonl", "session", new Map())
    await vi.advanceTimersByTimeAsync(10_000)
    expect(readdir).toHaveBeenCalledTimes(1)
    changed()
    await vi.advanceTimersByTimeAsync(0)
    expect(readdir).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(readdir).toHaveBeenCalledTimes(3)
    watcher.close()
    expect(close).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(readdir).toHaveBeenCalledTimes(3)
  })

  it("starts watching a directory created after the session and recovers from watcher errors", async () => {
    const close = vi.fn()
    let failed!: () => void
    const liveWatch = () => ({ close, on: (_event: string, callback: () => void) => { failed = callback } })
    const watcher = watchSubagents("/tmp/session.jsonl", "session", new Map())
    watch.mockImplementation(liveWatch)
    readdir.mockResolvedValue([])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(watch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(readdir).toHaveBeenCalledTimes(2)
    watch.mockImplementation(() => { throw new Error("unavailable") })
    failed()
    expect(close).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(readdir).toHaveBeenCalledTimes(3)
    watch.mockImplementation(liveWatch)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(watch).toHaveBeenCalledTimes(4)
    watcher.close()
  })

  it("retains an unterminated record and forwards it once the newline arrives", async () => {
    const line = userLine("delegate 🙂")
    let source = Buffer.from(line)
    readdir.mockResolvedValue(["agent-a.jsonl"])
    mockSource(() => source)
    const watcher = watchSubagents(
      "/tmp/session.jsonl",
      "session",
      tasks({ a: { toolUseId: "tool-1" } }),
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
      tasks({ large: { toolUseId: "tool-large" } }),
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

  it("binds twins with identical prompts to their own Agent calls by task id", async () => {
    mockFiles({
      "agent-a1.jsonl": `${userLine("Reply with PONG.")}\n`,
      "agent-a2.jsonl": `${userLine("Reply with PONG.")}\n`,
    })
    const watcher = watchSubagents(
      "/tmp/session.jsonl",
      "session",
      tasks({ a1: { toolUseId: "tool-1" }, a2: { toolUseId: "tool-2" } }),
    )

    await vi.advanceTimersByTimeAsync(0)

    const attribution = forwardedAttribution()
    expect(attribution.get("a1")).toBe("tool-1")
    expect(attribution.get("a2")).toBe("tool-2")
    watcher.close()
  })

  it("leaves a transcript unread until its task is bound, then forwards it on rescan", async () => {
    mockFiles({ "agent-late.jsonl": `${userLine("hello")}\n` })
    const bound = new Map<string, SubagentTask>()
    const watcher = watchSubagents("/tmp/session.jsonl", "session", bound)

    await vi.advanceTimersByTimeAsync(0)
    expect(stat).not.toHaveBeenCalled()
    expect(appendFile).not.toHaveBeenCalled()

    bound.set("late", { toolUseId: "tool-late", forwardedBytes: 0 })
    watcher.rescan()
    await vi.advanceTimersByTimeAsync(0)

    expect(forwardedAttribution().get("late")).toBe("tool-late")
    watcher.close()
  })

  it("files a nested agent under the main-thread call it descends from", async () => {
    mockFiles({ "agent-inner.jsonl": `${userLine("Reply with PING.")}\n` })
    const watcher = watchSubagents(
      "/tmp/session.jsonl",
      "session",
      tasks({
        outer: { toolUseId: "tool-outer" },
        middle: { toolUseId: "tool-middle", parentTaskId: "outer" },
        inner: { toolUseId: "tool-inner", parentTaskId: "middle", subagentType: "Explore" },
      }),
    )

    await vi.advanceTimersByTimeAsync(0)

    const progress = JSON.parse(String(appendFile.mock.calls[0][1]).trim())
    expect(progress.parentToolUseID).toBe("tool-outer")
    expect(progress.data).toMatchObject({
      agentId: "inner",
      toolUseId: "tool-inner",
      parentAgentId: "middle",
      subagentType: "Explore",
    })
    watcher.close()
  })

  it("treats a parent task it never saw as no parent", async () => {
    mockFiles({ "agent-orphan.jsonl": `${userLine("hi")}\n` })
    const watcher = watchSubagents(
      "/tmp/session.jsonl",
      "session",
      tasks({ orphan: { toolUseId: "tool-orphan", parentTaskId: "gone" } }),
    )

    await vi.advanceTimersByTimeAsync(0)

    const progress = JSON.parse(String(appendFile.mock.calls[0][1]).trim())
    expect(progress.parentToolUseID).toBe("tool-orphan")
    expect(progress.data.parentAgentId).toBeUndefined()
    watcher.close()
  })

  it("does not forward a transcript again when a later watcher takes over", async () => {
    mockFiles({ "agent-a.jsonl": `${userLine("once")}\n` })
    const bound = tasks({ a: { toolUseId: "tool-a" } })
    const first = watchSubagents("/tmp/session.jsonl", "session", bound)
    await vi.advanceTimersByTimeAsync(0)
    expect(appendFile).toHaveBeenCalledOnce()
    first.close()

    const next = watchSubagents("/tmp/session.jsonl", "session", bound)
    await vi.advanceTimersByTimeAsync(0)

    expect(appendFile).toHaveBeenCalledOnce()
    next.close()
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
      tasks({ retry: { toolUseId: "tool-retry" } }),
    )

    await vi.advanceTimersByTimeAsync(0)
    expect(appendFile).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(appendFile).toHaveBeenCalledTimes(2)
    watcher.close()
  })

  it("reads only the transcript a file event names, and scans for anything else", async () => {
    const bodies: Record<string, string> = {
      "agent-a1.jsonl": `${userLine("one")}\n`,
      "agent-a2.jsonl": `${userLine("two")}\n`,
    }
    mockFiles(bodies)
    let changed!: (event: string, fileName: string | null) => void
    watch.mockImplementation((_path, _options, callback) => {
      changed = callback
      return { close: vi.fn(), on: vi.fn() }
    })
    const watcher = watchSubagents("/tmp/session.jsonl", "session", tasks({ a1: { toolUseId: "tool-1" }, a2: { toolUseId: "tool-2" } }))
    await vi.advanceTimersByTimeAsync(0)
    expect(readdir).toHaveBeenCalledOnce()
    expect(appendFile).toHaveBeenCalledTimes(2)

    bodies["agent-a1.jsonl"] += `${userLine("one more")}\n`
    mockFiles(bodies)
    stat.mockClear()
    changed("change", "agent-a1.jsonl")
    await vi.advanceTimersByTimeAsync(0)
    expect(readdir).toHaveBeenCalledOnce()
    expect(stat.mock.calls.map(([path]) => basename(String(path)))).toEqual(["agent-a1.jsonl"])
    expect(appendFile).toHaveBeenCalledTimes(3)
    expect(JSON.parse(String(appendFile.mock.calls[2][1])).data.agentId).toBe("a1")

    changed("rename", null)
    await vi.advanceTimersByTimeAsync(0)
    changed("change", "notes.txt")
    await vi.advanceTimersByTimeAsync(0)
    expect(readdir).toHaveBeenCalledTimes(3)
    expect(appendFile).toHaveBeenCalledTimes(3)
    watcher.close()
  })

  it("forwards each record once when file events arrive while a file is still being read", async () => {
    const pendingStat = deferred<{ size: number }>()
    const body = `${userLine("once")}\n`
    mockFiles({ "agent-a1.jsonl": body })
    let changed!: (event: string, fileName: string | null) => void
    watch.mockImplementation((_path, _options, callback) => {
      changed = callback
      return { close: vi.fn(), on: vi.fn() }
    })
    stat.mockReturnValueOnce(pendingStat.promise)
    const watcher = watchSubagents("/tmp/session.jsonl", "session", tasks({ a1: { toolUseId: "tool-1" } }))
    await vi.advanceTimersByTimeAsync(0)
    changed("change", "agent-a1.jsonl")
    changed("change", "agent-a1.jsonl")
    pendingStat.resolve({ size: Buffer.byteLength(body) })
    await vi.advanceTimersByTimeAsync(0)
    expect(appendFile).toHaveBeenCalledOnce()
    watcher.close()
  })

  it("handles a file event that lands while a drain is finishing, without waiting for the backstop", async () => {
    for (let ticks = 0; ticks <= 12; ticks++) {
      appendFile.mockClear()
      const body = Buffer.from(`${userLine("late event")}\n`)
      stat.mockImplementation(async () => ({ size: body.length }))
      open.mockImplementation(async () => ({
        read: vi.fn(async (buffer: Buffer, _o: number, length: number, position: number) => ({ bytesRead: body.copy(buffer, 0, position, position + length) })),
        close: vi.fn().mockResolvedValue(undefined),
      }))
      let changed!: (event: string, fileName: string | null) => void
      watch.mockImplementation((_path, _options, callback) => {
        changed = callback
        return { close: vi.fn(), on: vi.fn() }
      })
      readdir.mockImplementationOnce(async () => {
        let chain = Promise.resolve()
        for (let i = 0; i < ticks; i++) chain = chain.then(() => {})
        void chain.then(() => changed("change", "agent-a1.jsonl"))
        return []
      })
      const watcher = watchSubagents("/tmp/session.jsonl", "session", tasks({ a1: { toolUseId: "tool-1" } }))
      await vi.advanceTimersByTimeAsync(0)
      expect(appendFile, `event ${ticks} microtasks after the scan`).toHaveBeenCalledOnce()
      watcher.close()
    }
  })
})
