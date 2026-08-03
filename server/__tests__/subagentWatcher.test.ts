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

/** agentId → parentToolUseID across every synthesized progress entry. */
function forwardedAttribution(): Map<string, string> {
  const seen = new Map<string, string>()
  for (const call of appendFile.mock.calls) {
    const entry = JSON.parse(String(call[1]).trim())
    seen.set(entry.data.agentId, entry.parentToolUseID)
  }
  return seen
}

// Sibling agents launched in one batch share a long prompt preamble; the head
// comparison alone cannot tell them apart.
const PREAMBLE = "Repo: /Users/dev/agent-window (branch worktree-mission-control). ".padEnd(140, "-")

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

  it("gives each sibling its own Task call when their prompts share a preamble", async () => {
    const promptA = `${PREAMBLE} Simplify the streaming overlay.`
    const promptB = `${PREAMBLE} Simplify the diff viewer.`
    const promptC = `${PREAMBLE} Simplify the file-changes panel.`
    mockFiles({
      "agent-a.jsonl": `${userLine(promptA)}\n`,
      "agent-b.jsonl": `${userLine(promptB)}\n`,
      "agent-c.jsonl": `${userLine(promptC)}\n`,
    })
    const watcher = watchSubagents(
      "/tmp/session.jsonl",
      "session",
      new Map([["tool-a", promptA], ["tool-b", promptB], ["tool-c", promptC]]),
    )

    await vi.advanceTimersByTimeAsync(0)

    const attribution = forwardedAttribution()
    expect(attribution.get("a")).toBe("tool-a")
    expect(attribution.get("b")).toBe("tool-b")
    expect(attribution.get("c")).toBe("tool-c")
    expect(new Set(attribution.values()).size).toBe(3)
    watcher.close()
  })

  it("never hands the same Task call to two agents", async () => {
    const promptC = `${PREAMBLE} Simplify the file-changes panel.`
    // a and b match no prompt exactly and both match every head — unresolvable.
    mockFiles({
      "agent-a.jsonl": `${userLine(`${PREAMBLE} unrelated tail one`)}\n`,
      "agent-b.jsonl": `${userLine(`${PREAMBLE} unrelated tail two`)}\n`,
      "agent-c.jsonl": `${userLine(promptC)}\n`,
    })
    const watcher = watchSubagents(
      "/tmp/session.jsonl",
      "session",
      new Map([
        ["tool-a", `${PREAMBLE} Simplify the streaming overlay.`],
        ["tool-b", `${PREAMBLE} Simplify the diff viewer.`],
        ["tool-c", promptC],
      ]),
    )

    await vi.advanceTimersByTimeAsync(0)

    // Refusing to guess beats attributing both agents to one Task call — but
    // the agent that can prove ownership is still forwarded.
    const attribution = forwardedAttribution()
    expect(attribution.has("a")).toBe(false)
    expect(attribution.has("b")).toBe(false)
    expect(attribution.get("c")).toBe("tool-c")
    watcher.close()
  })

  it("holds a claim across scan cycles as later agent files appear", async () => {
    const promptA = `${PREAMBLE} Simplify the streaming overlay.`
    const promptB = `${PREAMBLE} Simplify the diff viewer.`
    const pending = new Map([["tool-a", promptA], ["tool-b", promptB]])
    mockFiles({ "agent-a.jsonl": `${userLine(promptA)}\n` })
    const watcher = watchSubagents("/tmp/session.jsonl", "session", pending)

    await vi.advanceTimersByTimeAsync(0)
    expect(forwardedAttribution().get("a")).toBe("tool-a")

    // b shows up only on a later scan; a's claim on tool-a must still stand.
    mockFiles({
      "agent-a.jsonl": `${userLine(promptA)}\n`,
      "agent-b.jsonl": `${userLine(promptB)}\n`,
    })
    await vi.advanceTimersByTimeAsync(2_000)

    const attribution = forwardedAttribution()
    expect(attribution.get("a")).toBe("tool-a")
    expect(attribution.get("b")).toBe("tool-b")
    watcher.close()
  })

  it("lets a proven match take over a Task call a weak head match had guessed", async () => {
    const promptA = `${PREAMBLE} Simplify the streaming overlay.`
    // b resolves first, but only via the weak head comparison.
    mockFiles({ "agent-b.jsonl": `${userLine(`${PREAMBLE} rewritten tail`)}\n` })
    const pending = new Map([["tool-a", promptA]])
    const watcher = watchSubagents("/tmp/session.jsonl", "session", pending)

    await vi.advanceTimersByTimeAsync(0)
    expect(forwardedAttribution().get("b")).toBe("tool-a")

    mockFiles({
      "agent-b.jsonl": `${userLine(`${PREAMBLE} rewritten tail`)}\n`,
      "agent-a.jsonl": `${userLine(promptA)}\n`,
    })
    await vi.advanceTimersByTimeAsync(2_000)

    // The agent that can prove ownership wins the id outright.
    expect(forwardedAttribution().get("a")).toBe("tool-a")
    watcher.close()
  })

  it("does not treat an empty Task prompt as a wildcard", async () => {
    mockFiles({ "agent-a.jsonl": `${userLine("some subagent opening message")}\n` })
    const watcher = watchSubagents("/tmp/session.jsonl", "session", new Map([["tool-empty", ""]]))

    await vi.advanceTimersByTimeAsync(0)

    expect(appendFile).not.toHaveBeenCalled()
    watcher.close()
  })

  it("still matches on the prompt head when only one Task call can match", async () => {
    mockFiles({ "agent-a.jsonl": `${userLine(`${PREAMBLE} tail rewritten by the CLI`)}\n` })
    const watcher = watchSubagents(
      "/tmp/session.jsonl",
      "session",
      new Map([["tool-a", `${PREAMBLE} original tail`]]),
    )

    await vi.advanceTimersByTimeAsync(0)

    expect(forwardedAttribution().get("a")).toBe("tool-a")
    watcher.close()
  })

  it("prefers the most specific prompt when one is a prefix of another", async () => {
    mockFiles({ "agent-a.jsonl": `${userLine(`${PREAMBLE} review the parser carefully`)}\n` })
    const watcher = watchSubagents(
      "/tmp/session.jsonl",
      "session",
      new Map([["tool-short", PREAMBLE], ["tool-long", `${PREAMBLE} review the parser`]]),
    )

    await vi.advanceTimersByTimeAsync(0)

    expect(forwardedAttribution().get("a")).toBe("tool-long")
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
