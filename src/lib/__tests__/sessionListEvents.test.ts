import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))

import { __resetSessionListEventsForTest, subscribeSessionListEvents } from "@/lib/sessionListEvents"

class FakeEventSource extends EventTarget {
  static readonly CLOSED = 2
  static instances: FakeEventSource[] = []
  readyState = 1
  closed = false

  constructor(readonly url: string) {
    super()
    FakeEventSource.instances.push(this)
  }

  close(): void {
    this.closed = true
    this.readyState = FakeEventSource.CLOSED
  }

  version(version: number): void {
    this.dispatchEvent(new MessageEvent("version", { data: JSON.stringify({ version }) }))
  }

  giveUp(): void {
    this.readyState = FakeEventSource.CLOSED
    this.dispatchEvent(new Event("error"))
  }
}

function handlers() {
  return { onVersion: vi.fn<(version: number) => void>(), onUnsupported: vi.fn<() => void>() }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

describe("subscribeSessionListEvents", () => {
  beforeEach(() => {
    FakeEventSource.instances = []
    vi.stubGlobal("EventSource", FakeEventSource)
    mocks.authFetch.mockReset()
  })

  afterEach(() => {
    __resetSessionListEventsForTest()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it("shares one stream between subscribers and closes it with the last one", () => {
    const first = handlers()
    const second = handlers()
    const stopFirst = subscribeSessionListEvents(first)
    const stopSecond = subscribeSessionListEvents(second)

    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.instances[0].url).toBe("/api/session-list/events")
    FakeEventSource.instances[0].version(7)
    expect(first.onVersion).toHaveBeenCalledWith(7)
    expect(second.onVersion).toHaveBeenCalledWith(7)

    stopFirst()
    expect(FakeEventSource.instances[0].closed).toBe(false)
    stopSecond()
    expect(FakeEventSource.instances[0].closed).toBe(true)
  })

  it("ignores events that carry no version", () => {
    const listener = handlers()
    subscribeSessionListEvents(listener)
    FakeEventSource.instances[0].dispatchEvent(new MessageEvent("version", { data: "nope" }))
    expect(listener.onVersion).not.toHaveBeenCalled()
  })

  it("reports a server without the stream, also to a later subscriber, and stops asking", async () => {
    mocks.authFetch.mockResolvedValue(new Response("{}", { status: 404 }))
    const first = handlers()
    subscribeSessionListEvents(first)
    FakeEventSource.instances[0].giveUp()
    await flush()

    expect(first.onUnsupported).toHaveBeenCalledOnce()
    const later = handlers()
    subscribeSessionListEvents(later)
    await flush()
    expect(later.onUnsupported).toHaveBeenCalledOnce()
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it.each([401, 403])("falls back to polling when the server refuses the stream with %i", async (status) => {
    vi.useFakeTimers()
    mocks.authFetch.mockResolvedValue(new Response("{}", { status }))
    const listener = handlers()
    subscribeSessionListEvents(listener)
    FakeEventSource.instances[0].giveUp()
    await vi.advanceTimersByTimeAsync(0)

    expect(listener.onUnsupported).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it("reconnects with a delay after a stream that failed for another reason", async () => {
    vi.useFakeTimers()
    mocks.authFetch.mockResolvedValue(new Response("", { status: 503 }))
    const listener = handlers()
    subscribeSessionListEvents(listener)
    FakeEventSource.instances[0].giveUp()
    await vi.advanceTimersByTimeAsync(0)

    expect(listener.onUnsupported).not.toHaveBeenCalled()
    expect(FakeEventSource.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeEventSource.instances).toHaveLength(2)
  })

  it("leaves a dropped connection to the browser's own reconnect", () => {
    subscribeSessionListEvents(handlers())
    const source = FakeEventSource.instances[0]
    source.readyState = 0
    source.dispatchEvent(new Event("error"))
    expect(mocks.authFetch).not.toHaveBeenCalled()
  })

  it("reports no stream where the browser has no EventSource", async () => {
    vi.stubGlobal("EventSource", undefined)
    const listener = handlers()
    subscribeSessionListEvents(listener)
    await flush()
    expect(listener.onUnsupported).toHaveBeenCalledOnce()
  })
})
