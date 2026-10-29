import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook } from "@testing-library/react"
import { WORKER_REQUEST_TIMEOUT_MS, useParserWorker } from "../useParserWorker"
import type { ParsedSession } from "../../../shared/session/types"

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  onmessageerror: ((e: MessageEvent) => void) | null = null
  posted: Array<{ id: number }> = []
  terminated = false
  throwOnPost: Error | null = null

  constructor() {
    FakeWorker.instances.push(this)
  }

  postMessage(msg: { id: number }) {
    if (this.throwOnPost) throw this.throwOnPost
    this.posted.push(msg)
  }

  terminate() {
    this.terminated = true
  }

  answer(session: Partial<ParsedSession>) {
    const id = this.posted[this.posted.length - 1].id
    this.onmessage?.({ data: { type: "result", id, session } } as MessageEvent)
  }
}

const latest = () => FakeWorker.instances[FakeWorker.instances.length - 1]

describe("useParserWorker", () => {
  beforeEach(() => {
    FakeWorker.instances = []
    vi.stubGlobal("Worker", FakeWorker)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it("resolves a request with the worker's answer", async () => {
    const { result } = renderHook(() => useParserWorker())
    const parsed = result.current.parse("{}")
    latest().answer({ sessionId: "s1" })
    await expect(parsed).resolves.toEqual({ sessionId: "s1" })
  })

  it("rejects pending requests and starts a fresh worker when the worker crashes", async () => {
    const { result } = renderHook(() => useParserWorker())
    const crashed = latest()
    const parsed = result.current.parse("{}")

    crashed.onerror?.({ message: "out of memory" } as ErrorEvent)

    await expect(parsed).rejects.toThrow("Worker error: out of memory")
    expect(crashed.terminated).toBe(true)
    expect(FakeWorker.instances).toHaveLength(2)

    const retried = result.current.parse("{}")
    expect(crashed.posted).toHaveLength(1)
    latest().answer({ sessionId: "s2" })
    await expect(retried).resolves.toEqual({ sessionId: "s2" })
  })

  it("replaces a worker that never answers", async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useParserWorker())
    const silent = latest()
    const parsed = result.current.parse("{}")

    vi.advanceTimersByTime(WORKER_REQUEST_TIMEOUT_MS)

    await expect(parsed).rejects.toThrow("Worker did not answer")
    expect(silent.terminated).toBe(true)
    expect(FakeWorker.instances).toHaveLength(2)
  })

  it("rejects a request whose message cannot be sent", async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useParserWorker())
    latest().throwOnPost = new Error("Data cannot be cloned, out of memory.")

    await expect(result.current.parse("{}")).rejects.toThrow("out of memory")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("terminates the worker on unmount", async () => {
    const { result, unmount } = renderHook(() => useParserWorker())
    const worker = latest()
    const parsed = result.current.parse("{}")
    unmount()
    await expect(parsed).rejects.toThrow("Worker terminated")
    expect(worker.terminated).toBe(true)
    expect(FakeWorker.instances).toHaveLength(1)
  })
})
